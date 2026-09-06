import { dirname, join } from 'node:path';
import type { MessageDto, ReviewConversationResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { logger } from '../logging.ts';
import { newId } from '../ids.ts';
import type { AutomergeStoreHolder } from '../document/automerge-store-holder.ts';
import type { EventPublisher } from '../events/event-publisher.ts';
import type { PiService } from '../pi/pi-service.ts';
import type { ConversationRow, DocumentRow, StorageAdapter } from '../storage/storage-adapter.ts';
import { toConversationDto } from './conversation-mapper.ts';

/**
 * Callbacks `ConversationService.review()` supplies for the one bit of glue this service can't own
 * itself without creating a construction cycle: sending the review's seed message goes through
 * `ConversationService.send()` (concurrency-limiter admission, turn wiring, etc. — the exact same
 * path any other message takes), and reading a conversation's message history
 * (`ConversationService.buildMessages`, used by the fallback-transcript path) is private state
 * `ConversationService` already owns. Passed in per-call rather than bound at construction time so
 * neither service needs a reference to the other's instance.
 */
export interface ReviewCallbacks {
  sendMessage: (conversationId: string, message: string) => Promise<unknown>;
  buildMessages: (conversationId: string) => MessageDto[];
}

/**
 * FR-036's independent review of a closed conversation and its branches. Depends on the same
 * `storage`/`piService`/`publisher` primitives (plus `automerge`, for the content mapping
 * `toConversationDto` needs) `ConversationService` already has injected.
 * `ConversationService.review()` still owns validating the target conversation/document (so its
 * thrown errors stay exactly where callers already expect them) before delegating the rest here.
 */
export class ConversationReviewService {
  private readonly storage: StorageAdapter;
  private readonly piService: PiService;
  private readonly publisher: EventPublisher;
  private readonly automerge: AutomergeStoreHolder;

  constructor(storage: StorageAdapter, piService: PiService, publisher: EventPublisher, automerge: AutomergeStoreHolder) {
    this.storage = storage;
    this.piService = piService;
    this.publisher = publisher;
    this.automerge = automerge;
  }

  /**
   * FR-036: an independent review of a closed conversation and its branches, produced as a new
   * `kind: 'review'` conversation and never injected into any existing conversation. Read-only
   * with respect to the reviewed conversation(s): the transcript is read via
   * `PiService.readClosedTranscript` (`SessionManager.open` + `getEntries()`, research R1)
   * without ever prompting the closed session itself, so it is left byte-identical
   * (quickstart.md US7 scenario 3). A review conversation counts against `maxConcurrentAgents`
   * like any other agent run (the seed message below goes through the ordinary `send()` path) but
   * is exempt from `maxConversationDepth`/`maxEditingDepth`: it has no `parentId` and
   * `branchDepth: 0`, outside the branching/editing workflow entirely.
   */
  review(target: ConversationRow, document: DocumentRow, callbacks: ReviewCallbacks): ReviewConversationResponse {
    const reviewedConversationIds = this.collectWithDescendants(document.id, target.id);
    const transcriptLines =
      this.piService.readClosedTranscript(target.piSessionPath) ??
      this.buildFallbackTranscript(reviewedConversationIds, callbacks.buildMessages);

    const now = new Date().toISOString();
    const id = newId('conv');
    const piSessionPath = join(dirname(target.piSessionPath), `${id}.jsonl`);

    const row = this.storage.createConversation({
      id,
      documentId: document.id,
      parentId: null,
      name: `Review: ${target.name}`,
      kind: 'review',
      piSessionPath,
      status: 'idle',
      errorMessage: null,
      isPrimary: false,
      isCurrentMain: false,
      contextRevision: document.currentRevision,
      branchDepth: 0,
      seedSelection: null,
      forkedFromMessageId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });

    this.publisher.publish(document.id, row.id, 'conversation_started', {
      conversationId: row.id,
      name: row.name,
      kind: row.kind,
      parentId: row.parentId,
      branchDepth: row.branchDepth,
      contextRevision: row.contextRevision,
      seedSelection: row.seedSelection,
      forkedFromMessageId: row.forkedFromMessageId,
    });

    const seedMessage = [
      `You are independently reviewing the closed conversation "${target.name}" and its ` +
        'branches, without altering them. You have no tool access to them — this is a read-only ' +
        'review based on the transcript below.',
      '',
      transcriptLines.length > 0 ? transcriptLines.join('\n\n') : '(No messages were recorded in this conversation.)',
    ].join('\n');

    // Fire-and-forget, same convention as branch()'s seed message: POST /api/conversations/:id/review
    // returns as soon as the review conversation exists; its own progress surfaces over the event
    // stream (http-api.md, FR-037).
    void callbacks.sendMessage(row.id, seedMessage).catch((err) => {
      // `event: 'agent_error'` is the vocabulary term for a Pi call failing with no other event
      // of its own (FR-042).
      logger.warn(
        { event: 'agent_error', conversationId: row.id, err: err instanceof Error ? err.message : String(err) },
        'failed to deliver review seed message',
      );
    });

    return {
      conversation: toConversationDto(this.storage, row, document.currentRevision, this.automerge.get().getContent()),
      reviewedConversationIds,
    };
  }

  /** Every conversation descending from `rootId` (its branches, at any depth), plus `rootId`
   *  itself — "a closed conversation and its branches" (FR-036). A descendant's own open/closed
   *  status is irrelevant here: review reads it but never alters it (FR-035a stays intact). */
  private collectWithDescendants(documentId: string, rootId: string): string[] {
    const all = this.storage.listAllConversations(documentId);
    const byParent = new Map<string, ConversationRow[]>();
    for (const conv of all) {
      if (!conv.parentId) continue;
      const list = byParent.get(conv.parentId) ?? [];
      list.push(conv);
      byParent.set(conv.parentId, list);
    }
    const ids: string[] = [];
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      ids.push(id);
      for (const child of byParent.get(id) ?? []) stack.push(child.id);
    }
    return ids;
  }

  /** Fallback transcript source when no real Pi session file exists on disk yet — always true
   *  under `RADR_BE_PI_FAKE_SESSIONS=1` (`FakeAgentSession` never persists to disk), in which case the
   *  application's own stored event log is the only record of what was said. */
  private buildFallbackTranscript(conversationIds: string[], buildMessages: (id: string) => MessageDto[]): string[] {
    const lines: string[] = [];
    for (const id of conversationIds) {
      const conv = this.storage.getConversation(id);
      if (!conv) continue;
      lines.push(`--- ${conv.name} ---`);
      for (const message of buildMessages(id)) {
        lines.push(`${message.role}: ${message.text}`);
      }
    }
    return lines;
  }
}
