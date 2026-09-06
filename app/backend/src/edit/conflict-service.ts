import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import { EventPublisher } from '../events/event-publisher.ts';
import type { ConflictDetail, EditOperation, StagedEditRow, StorageAdapter } from '../storage/storage-adapter.ts';
import type { AutomergeStoreHolder } from '../document/automerge-store-holder.ts';

export interface ConflictOutcome {
  outcome: 'conflict' | 'conflict_exhausted';
  editId: string;
  conflictDetail: ConflictDetail;
  replacementRequested: boolean;
  /** The attempt number the next replacement would carry (requested) or already carries (exhausted). */
  replacementAttempt: number;
  attemptsRemaining: number;
  /** Present only when exhausted — the superseded edit's own (already-maxed) attempt number. */
  attempts?: number;
  /** Present only when exhausted — the root of the supersession chain. */
  originalStagedEditId?: string;
  /** Human-readable rendering of `conflictDetail`, suitable as a tool result or a follow-up prompt
   *  to the originating agent (agent-tools.md §propose_document_edit "Result — conflict"). */
  message: string;
}

function reasonText(reason: 'not_found' | 'ambiguous' | 'overlapping', occurrences: number): string {
  switch (reason) {
    case 'not_found':
      return 'the `old_string` was not found in the current document.';
    case 'ambiguous':
      return `the \`old_string\` occurs ${occurrences} times in the current document (must be unique).`;
    case 'overlapping':
      return 'this operation overlaps another operation in the same proposal.';
  }
}

function renderConflictMessage(
  operations: EditOperation[],
  detail: ConflictDetail,
  currentContent: string,
  status: 'requested' | 'exhausted',
  maxReplacementAttempts: number,
): string {
  const lines: string[] = ['This proposal could not be applied: the text it targets has changed.', ''];
  operations.forEach((_op, index) => {
    const conflict = detail.operations.find((o) => o.index === index);
    lines.push(
      conflict
        ? `Operation ${index + 1}: ${reasonText(conflict.reason, conflict.occurrences)}`
        : `Operation ${index + 1}: applied cleanly (no action needed in isolation).`,
    );
  });
  lines.push('', 'Current text of the affected region:', currentContent, '');

  if (status === 'requested') {
    lines.push('Propose a replacement edit against the current document text shown above.');
  } else {
    lines.push(
      `No further automatic replacement will be requested — the maximum of ${maxReplacementAttempts} ` +
        'replacement attempt(s) for this proposal has been reached. The document is unchanged; a fresh ' +
        'request from the user will start a new proposal with its own budget.',
    );
  }
  return lines.join('\n');
}

/**
 * Records the outcome of a failed reconciliation (edit/edit-service.ts §apply) and decides whether
 * the originating agent should be asked for a replacement (FR-032/FR-032a/FR-032b). This service
 * never talks to Pi directly: it hands back a rendered message and lets the caller decide how to
 * deliver it — embedded in the same tool call's result when the conflict is detected synchronously
 * within an active turn (the Primary auto-apply path), or via a new `send()` when it is discovered
 * later, outside any active turn (edit-service.ts's async apply path). That split keeps this module
 * free of any dependency on PiService/ConversationService, avoiding a construction cycle with
 * PiService (which itself depends on EditService to build the `propose_document_edit` tool).
 */
export class ConflictService {
  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly automerge: AutomergeStoreHolder;
  private readonly publisher: EventPublisher;

  constructor(storage: StorageAdapter, eventService: EventService, eventHub: EventHub, automerge: AutomergeStoreHolder) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.automerge = automerge;
    this.publisher = new EventPublisher(eventService, eventHub);
  }

  /** Consumed by `EditService.stage` when creating a new proposal for `conversationId`.
   *
   *  This pointer is derived by querying persisted `staged_edit` rows, not tracked in an in-memory
   *  `Map` — the link between "conflict recorded as superseded" and "replacement staged" must
   *  survive a process restart in between, for FR-032a's chain-budget accounting to stay correct.
   *  Since `EditService.stage` persists the replacement with `supersedesId` pointing back at the
   *  superseded edit as part of the very same call that consumes this value, the query is
   *  naturally self-consuming: once that successor row exists, the superseded edit no longer
   *  qualifies as "awaiting" on any later call. No explicit delete/consume step is needed. */
  consumeAwaitingReplacement(conversationId: string): string | null {
    return this.findAwaitingReplacementId(conversationId);
  }

  /** A staged edit is "awaiting replacement" when it was superseded by a conflict (`status ===
   *  'superseded'`), no successor has been staged for it yet (no other edit in the conversation
   *  has `supersedesId` pointing back at it), and the chain-wide attempt budget had not been
   *  exhausted at the moment it was superseded — recomputed here via `getChainAttempts` so it
   *  exactly mirrors the `willRequest` decision `recordConflict` made when it set that status.
   *  When more than one such candidate exists (shouldn't happen in the normal single-active-chain
   *  flow), the most recently created one wins. */
  private findAwaitingReplacementId(conversationId: string): string | null {
    const edits = this.storage.listStagedEditsByConversation(conversationId);
    const alreadySucceeded = new Set(
      edits.map((e) => e.supersedesId).filter((id): id is string => id !== null),
    );
    const maxAttempts = this.storage.getSettings().maxReplacementAttempts;

    const candidates = edits
      .filter((e) => e.status === 'superseded' && !alreadySucceeded.has(e.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    for (const candidate of candidates) {
      if (this.getChainAttempts(candidate.id) < maxAttempts) return candidate.id;
    }
    return null;
  }

  /** Walks `supersedes_id` back to the root of `editId`'s supersession chain and returns the
   *  total number of replacement attempts made so far in that chain (FR-032a: the budget is
   *  shared by the whole chain descending from one original proposal, never reset per hop).
   *  `edit.replacementAttempt` is maintained as exactly this count (edit-service.ts `stage()`:
   *  `replacementAttempt = predecessor.replacementAttempt + 1`), so this walk is the
   *  independently-verifiable source of truth `recordConflict` below checks against, rather than
   *  trusting the stored field alone. */
  getChainAttempts(editId: string): number {
    let attempts = 0;
    let current = this.storage.getStagedEdit(editId);
    while (current?.supersedesId) {
      attempts += 1;
      current = this.storage.getStagedEdit(current.supersedesId);
    }
    return attempts;
  }

  recordConflict(edit: StagedEditRow, detail: ConflictDetail): ConflictOutcome {
    const maxAttempts = this.storage.getSettings().maxReplacementAttempts;
    const resolvedAt = new Date().toISOString();
    this.storage.updateStagedEdit(edit.id, { status: 'superseded', conflictDetail: detail, resolvedAt });

    // Chain-wide budget (FR-032a): derived by walking `supersedes_id`, not read off `edit`'s own
    // `replacementAttempt` field directly — see `getChainAttempts` above.
    const chainAttempts = this.getChainAttempts(edit.id);
    const willRequest = chainAttempts < maxAttempts;
    const nextAttempt = chainAttempts + 1;
    const attemptsRemaining = Math.max(0, maxAttempts - nextAttempt);

    // No explicit "awaiting replacement" marker to set here: `edit` now has `status: 'superseded'`
    // persisted above, and — when `willRequest` is true — `findAwaitingReplacementId` derives the
    // pending-replacement pointer straight from that row (see its doc comment) until a successor
    // staged edit points `supersedesId` back at it.

    this.publish(edit.documentId, edit.conversationId, 'staged_edit_superseded', {
      stagedEditId: edit.id,
      conflictDetail: detail,
      replacementRequested: willRequest,
      replacementAttempt: nextAttempt,
      attemptsRemaining,
    });

    const message = renderConflictMessage(
      edit.operations,
      detail,
      this.automerge.get().getContent(),
      willRequest ? 'requested' : 'exhausted',
      maxAttempts,
    );

    let originalStagedEditId: string | undefined;
    if (!willRequest) {
      originalStagedEditId = this.findOriginalId(edit);
      this.publish(edit.documentId, edit.conversationId, 'staged_edit_replacement_exhausted', {
        stagedEditId: edit.id,
        originalStagedEditId,
        attempts: chainAttempts,
        conflictDetail: detail,
      });
    }

    return {
      outcome: willRequest ? 'conflict' : 'conflict_exhausted',
      editId: edit.id,
      conflictDetail: detail,
      replacementRequested: willRequest,
      replacementAttempt: nextAttempt,
      attemptsRemaining,
      attempts: willRequest ? undefined : chainAttempts,
      originalStagedEditId,
      message,
    };
  }

  private findOriginalId(edit: StagedEditRow): string {
    let current = edit;
    while (current.supersedesId) {
      const predecessor = this.storage.getStagedEdit(current.supersedesId);
      if (!predecessor) break;
      current = predecessor;
    }
    return current.id;
  }

  private publish(
    documentId: string,
    conversationId: string | null,
    type: ApplicationEvent['type'],
    data: unknown,
  ): void {
    this.publisher.publish(documentId, conversationId, type, data);
  }
}
