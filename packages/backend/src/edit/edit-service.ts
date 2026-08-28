import { createHash } from 'node:crypto';
import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { ApplyEditResponse } from '@rapid-ai-document-review/shared/contracts/http';
import type { EditOperation as SharedEditOperation } from '@rapid-ai-document-review/shared/contracts/agent-tools';
import { newId } from '../ids.js';
import { logger } from '../logging.js';
import type { AutomergeStoreHolder } from '../document/automerge-store-holder.js';
import { reconcile } from '../document/text-anchor.js';
import type { RevisionService } from '../document/revision-service.js';
import type { EventHub } from '../events/event-hub.js';
import type { EventService } from '../events/event-service.js';
import type { RunBuffer } from '../events/run-buffer.js';
import type { ConcurrencyLimiter } from '../conversation/concurrency-limiter.js';
import { EventBridge } from '../pi/event-bridge.js';
import type { PiService } from '../pi/pi-service.js';
import type { ConversationRow, StagedEditRow, StorageAdapter } from '../storage/storage-adapter.js';
import { toStagedEditDto } from './edit-mapper.js';
import { previewStagedEdit } from './preview.js';
import type { ConflictService } from './conflict-service.js';

export class EditNotFoundError extends Error {}
export class EditNotPendingError extends Error {}

export interface ApplyOutcomeInternal {
  response: ApplyEditResponse;
  /** Present only for the two conflict outcomes — the rendered message a caller may embed as a
   *  tool result (Primary sync path) instead of triggering a new turn. */
  conflictMessage?: string;
}

/**
 * Stages, applies and drops agent-proposed edits (data-model.md §6, contracts/http-api.md §Proposed
 * edits). The sole write path for `staged_edit` rows and the only caller of `TextAnchor.reconcile`
 * against a live document (Principle III). Primary auto-apply is `stage()` immediately followed by
 * `apply()` — the exact same reconciliation code path non-Primary proposals use later, which is
 * what makes SC-004's "0% applied silently" claim structural rather than a convention two code
 * paths merely try to honor separately.
 */
export class EditService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly eventService: EventService,
    private readonly eventHub: EventHub,
    private readonly automerge: AutomergeStoreHolder,
    private readonly revisionService: RevisionService,
    private readonly conflictService: ConflictService,
    private readonly piService: PiService,
    private readonly concurrencyLimiter: ConcurrencyLimiter,
    private readonly runBuffer: RunBuffer,
  ) {}

  /** Non-Primary path (FR-021): always creates a `pending` row. Idempotent on `(conversationId,
   *  piToolCallId)` (FR-040). Links to a superseded predecessor via the conflict-service marker
   *  without the agent ever supplying `supersedes_id` itself (agent-tools.md §Conflict recovery). */
  stage(
    conversationId: string,
    piToolCallId: string,
    summary: string,
    operations: SharedEditOperation[],
    contextRevision: number,
  ): StagedEditRow {
    const existing = this.storage.getStagedEditByToolCall(conversationId, piToolCallId);
    if (existing) return existing;

    const conversation = this.storage.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);

    let supersedesId: string | null = null;
    let replacementAttempt = 0;
    const markerId = this.conflictService.consumeAwaitingReplacement(conversationId);
    if (markerId) {
      const predecessor = this.storage.getStagedEdit(markerId);
      if (predecessor) {
        supersedesId = predecessor.id;
        replacementAttempt = predecessor.replacementAttempt + 1;
      }
    }

    const row: StagedEditRow = {
      id: newId('edit'),
      documentId: conversation.documentId,
      conversationId,
      piToolCallId,
      sourceRevision: contextRevision,
      summary,
      operations,
      status: 'pending',
      // FR-027's second half: a *replacement* for a conflicting Primary edit is presented to the
      // user as a normal pending proposal, never re-attempted automatically — auto-apply only
      // ever applies to a conversation's fresh, non-replacement proposal (stageAndApplyPrimary
      // below branches on this same flag rather than re-deriving it from `conversation.isPrimary`).
      autoApplied: conversation.isPrimary && supersedesId === null,
      appliedRevision: null,
      supersedesId,
      conflictDetail: null,
      replacementAttempt,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    const created = this.storage.createStagedEdit(row);

    this.publish(conversation.documentId, conversationId, 'staged_edit_created', {
      stagedEditId: created.id,
      piToolCallId,
      summary,
      sourceRevision: contextRevision,
      operationCount: operations.length,
      supersedesId,
    });
    if (supersedesId) {
      this.publish(conversation.documentId, conversationId, 'staged_edit_replacement_created', {
        stagedEditId: created.id,
        supersedesId,
        summary,
        replacementAttempt,
      });
    }
    return created;
  }

  /** Primary path (FR-027): stage, then immediately reconcile through the identical `apply()` used
   *  by user-accepted proposals. Conflict messaging is embedded in the tool's own result rather
   *  than triggering a new turn — the conflict is discovered synchronously within the same active
   *  turn that proposed the edit, so the model can act on it without a fresh `send()`. */
  async stageAndApplyPrimary(
    conversationId: string,
    piToolCallId: string,
    summary: string,
    operations: SharedEditOperation[],
    contextRevision: number,
  ): Promise<{ edit: StagedEditRow; outcome: ApplyEditResponse['outcome'] | 'pending'; revision?: number; message?: string }> {
    const staged = this.stage(conversationId, piToolCallId, summary, operations, contextRevision);

    if (staged.status !== 'pending') {
      // Idempotent replay of an already-resolved primary tool call (FR-040).
      if (staged.status === 'applied') {
        return { edit: staged, outcome: 'applied', revision: staged.appliedRevision ?? undefined };
      }
      return {
        edit: staged,
        outcome: 'conflict',
        message: 'This proposal was already processed and could not be applied; see its status in the review UI.',
      };
    }

    if (!staged.autoApplied) {
      // FR-027: this is a replacement for a conflicting Primary edit (`stage()` above only
      // withholds auto-apply for that one case) — it is left pending for ordinary user review,
      // exactly like a non-Primary proposal, rather than being reconciled automatically here.
      return {
        edit: staged,
        outcome: 'pending',
        message: [
          `Proposal staged for review (${operations.length} operations).`,
          'The document is unchanged until the user accepts it.',
          `Proposal id: ${staged.id}`,
        ].join('\n'),
      };
    }

    const result = await this.apply(staged.id, { requestReplacementViaNewTurn: false });
    const updated = this.storage.getStagedEdit(staged.id) ?? staged;
    if (result.response.outcome === 'applied') {
      return { edit: updated, outcome: 'applied', revision: result.response.revision };
    }
    return { edit: updated, outcome: result.response.outcome, message: result.conflictMessage };
  }

  /** Reconciles and applies (or supersedes) one pending edit. Idempotent on an already-`applied`
   *  edit (FR-040). `requestReplacementViaNewTurn` is `false` only when called synchronously from
   *  within the proposing tool call's own execution (the Primary path) — the caller then embeds
   *  `conflictMessage` in that same tool's result instead of a new turn being started here. */
  async apply(editId: string, opts: { requestReplacementViaNewTurn?: boolean } = {}): Promise<ApplyOutcomeInternal> {
    const requestViaNewTurn = opts.requestReplacementViaNewTurn ?? true;
    const edit = this.storage.getStagedEdit(editId);
    if (!edit) throw new EditNotFoundError(`Staged edit not found: ${editId}`);

    if (edit.status === 'applied') {
      return {
        response: {
          outcome: 'applied',
          stagedEditId: edit.id,
          revision: edit.appliedRevision ?? 0,
          content: this.automerge.get().getContent(),
        },
      };
    }
    if (edit.status !== 'pending') {
      throw new EditNotPendingError(`Staged edit is not pending: ${editId} (status: ${edit.status})`);
    }

    const currentText = this.automerge.get().getContent();
    const result = reconcile(edit.operations, currentText);

    if (result.outcome === 'clean') {
      return { response: this.applyClean(edit, result.patches) };
    }

    const conflictOutcome = this.conflictService.recordConflict(edit, result.detail);
    if (conflictOutcome.replacementRequested && requestViaNewTurn) {
      const conversation = this.storage.getConversation(edit.conversationId);
      if (conversation) this.requestReplacement(conversation, conflictOutcome.message);
    }

    const response: ApplyEditResponse =
      conflictOutcome.outcome === 'conflict'
        ? {
            outcome: 'conflict',
            stagedEditId: edit.id,
            supersededEditId: edit.id,
            conflictDetail: conflictOutcome.conflictDetail,
            replacementRequested: conflictOutcome.replacementRequested,
            replacementAttempt: conflictOutcome.replacementAttempt,
            attemptsRemaining: conflictOutcome.attemptsRemaining,
          }
        : {
            outcome: 'conflict_exhausted',
            stagedEditId: edit.id,
            supersededEditId: edit.id,
            originalStagedEditId: conflictOutcome.originalStagedEditId ?? edit.id,
            conflictDetail: conflictOutcome.conflictDetail,
            replacementRequested: false,
            attempts: conflictOutcome.attempts ?? edit.replacementAttempt,
          };

    return { response, conflictMessage: conflictOutcome.message };
  }

  drop(editId: string): StagedEditRow {
    const edit = this.storage.getStagedEdit(editId);
    if (!edit) throw new EditNotFoundError(`Staged edit not found: ${editId}`);
    if (edit.status !== 'pending') {
      throw new EditNotPendingError(`Staged edit is not pending: ${editId} (status: ${edit.status})`);
    }
    const resolvedAt = new Date().toISOString();
    const updated = this.storage.updateStagedEdit(editId, { status: 'dropped', resolvedAt });
    this.publish(edit.documentId, edit.conversationId, 'staged_edit_dropped', { stagedEditId: edit.id });
    return updated;
  }

  async acceptRemaining(
    conversationId: string,
  ): Promise<{ results: { stagedEditId: string; outcome: string; revision?: number; replacementRequested?: boolean }[]; currentRevision: number }> {
    const pending = this.storage
      .listStagedEditsByConversation(conversationId)
      .filter((e) => e.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const results: { stagedEditId: string; outcome: string; revision?: number; replacementRequested?: boolean }[] = [];
    for (const edit of pending) {
      const { response } = await this.apply(edit.id);
      if (response.outcome === 'applied') {
        results.push({ stagedEditId: edit.id, outcome: 'applied', revision: response.revision });
      } else {
        results.push({ stagedEditId: edit.id, outcome: response.outcome, replacementRequested: response.replacementRequested });
      }
    }

    const document = this.storage.getDocument();
    return { results, currentRevision: document?.currentRevision ?? 0 };
  }

  dropRemaining(conversationId: string): string[] {
    const pending = this.storage.listStagedEditsByConversation(conversationId).filter((e) => e.status === 'pending');
    const droppedIds: string[] = [];
    for (const edit of pending) {
      this.drop(edit.id);
      droppedIds.push(edit.id);
    }
    return droppedIds;
  }

  listForConversation(conversationId: string) {
    return this.storage.listStagedEditsByConversation(conversationId).map(toStagedEditDto);
  }

  getOrThrow(editId: string): StagedEditRow {
    const edit = this.storage.getStagedEdit(editId);
    if (!edit) throw new EditNotFoundError(`Staged edit not found: ${editId}`);
    return edit;
  }

  preview(editId: string) {
    const edit = this.getOrThrow(editId);
    return previewStagedEdit(edit, this.automerge.get().getContent());
  }

  private applyClean(edit: StagedEditRow, patches: { from: number; to: number; insert: string }[]): ApplyEditResponse {
    const document = this.storage.getDocument();
    if (!document) throw new Error('Document not found');
    const conversation = this.storage.getConversation(edit.conversationId);
    const predictedRevision = document.currentRevision + 1;

    this.automerge.get().splice(patches);

    const resolvedAt = new Date().toISOString();
    this.storage.updateStagedEdit(edit.id, { status: 'applied', appliedRevision: predictedRevision, resolvedAt });

    // FR-016: applying (or auto-applying) its own proposed edit updates this conversation's own
    // context revision immediately to match — done *before* `revisionService.createRevision`
    // below so that call's `conversation_stale` notification (document-service.ts
    // `notifyRevisionCreated`) never sees this conversation as "one behind" a revision it caused
    // itself.
    this.storage.updateConversation(edit.conversationId, { contextRevision: predictedRevision });

    // Ordering guarantee #4 (websocket-events.md): staged_edit_applied precedes both
    // document_content_changed and revision_created.
    this.publish(edit.documentId, edit.conversationId, 'staged_edit_applied', {
      stagedEditId: edit.id,
      revision: predictedRevision,
      autoApplied: edit.autoApplied,
    });

    const content = this.automerge.get().getContent();
    const contentHash = createHash('sha256').update(content).digest('hex');
    this.publish(edit.documentId, null, 'document_content_changed', {
      changes: patches,
      currentRevision: document.currentRevision,
      originConversationId: edit.conversationId,
      contentHash,
    });

    const revisionRow = this.revisionService.createRevision(edit.documentId, {
      source: 'agent',
      origin: 'agent_edit',
      conversationId: edit.conversationId,
      stagedEditId: edit.id,
      note: `Applied edit from "${conversation?.name ?? edit.conversationId}"`,
      autoApplied: edit.autoApplied,
    });

    return { outcome: 'applied', stagedEditId: edit.id, revision: revisionRow.revision, content };
  }

  /** Starts a brand-new turn asking the originating agent for a replacement, for a conflict
   *  discovered outside any active turn (edits.ts's async apply/accept-remaining routes). Mirrors
   *  ConversationService.send's turn/bridge/concurrency-limiter wiring directly (rather than
   *  depending on ConversationService) so EditService/ConflictService never need a value-level
   *  reference back to ConversationService — PiService already depends on EditService to build the
   *  `propose_document_edit` tool, and a further edge back through ConversationService would create
   *  a real construction cycle, not just a type-only one. */
  private requestReplacement(conversation: ConversationRow, message: string): void {
    if (conversation.status === 'closed') {
      // No `event` field: skipping the request means no domain event fires at all for it
      // (FR-042) — `staged_edit_replacement_exhausted` covers a spent budget, not this case.
      logger.warn({ conversationId: conversation.id }, 'not requesting a replacement on a closed conversation');
      return;
    }

    this.publishSystemMessage(conversation.documentId, conversation.id, message);

    const turnId = newId('turn');
    const bridge = new EventBridge(
      this.storage,
      this.eventService,
      this.eventHub,
      this.runBuffer,
      { documentId: conversation.documentId, conversationId: conversation.id, turnId },
      () => this.concurrencyLimiter.release(conversation.documentId, conversation.id),
    );
    const run = () => this.piService.send(conversation, message, bridge);
    this.concurrencyLimiter.acquire(conversation.documentId, conversation.id, turnId, conversation.contextRevision, run);
  }

  private publishSystemMessage(documentId: string, conversationId: string, text: string): void {
    const data = { messageId: newId('msg'), role: 'user' as const, text, reasoning: null };
    this.publish(documentId, conversationId, 'message_completed', data);
  }

  private publish(
    documentId: string,
    conversationId: string | null,
    type: ApplicationEvent['type'],
    data: unknown,
  ): void {
    const persisted = this.eventService.append(documentId, conversationId, type, data);
    this.eventHub.broadcast(
      documentId,
      {
        type,
        sequence: persisted.sequence,
        documentId,
        conversationId,
        at: persisted.createdAt,
        data,
      } as unknown as ApplicationEvent,
    );
  }
}
