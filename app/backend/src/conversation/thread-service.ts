import { join } from 'node:path';
import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import { DocumentNotFoundError } from '../document/document-service.ts';
import { newId } from '../ids.ts';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import { EventPublisher } from '../events/event-publisher.ts';
import { getPendingStagedEditIds } from '../edit/edit-mapper.ts';
import type { PiService } from '../pi/pi-service.ts';
import { buildThreadBranchSeedMessage } from '@rapid-ai-document-review/shared/domain';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.ts';
import {
  ConversationNotFoundError,
  MaxConversationDepthExceededError,
  type ConversationService,
} from './conversation-service.ts';
import { toConversationDto } from './conversation-mapper.ts';
import { buildConversationMessages } from './message-log.ts';
import { deriveBranchName, normalizeForHighlightMatch } from './seed-excerpt.ts';

export class InvalidHighlightError extends Error {}
export class AnchorIsTipError extends Error {}
export class PendingEditsBlockDoneError extends Error {
  readonly pendingEditIds: string[];

  constructor(message: string, pendingEditIds: string[]) {
    super(message);
    this.pendingEditIds = pendingEditIds;
  }
}

export interface BranchFromHighlightRequest {
  parentThreadId: string;
  anchorMessageId: string;
  highlightedText: string;
  name?: string;
}

/**
 * Linear thread mode's (011-linear-thread-mode) conversation-lifecycle service: creating the one
 * auto-created root Thread per `documentType: 'thread'` document, branching from a highlighted
 * passage in an earlier message, and marking a Thread done/reopening it. Deliberately a separate
 * class from `ConversationService` — per data-model.md's storage-layer-changes note, the
 * Pi-session strategy (one shared file, leaf-repositioned per Thread, research.md R1) and the
 * anchor resolution (message-shaped, not document-offset-shaped, research.md R2) are both
 * genuinely different from every existing `ConversationService` code path, not a small variant of
 * them.
 */
export class ThreadService {
  private readonly storage: StorageAdapter;
  private readonly piService: PiService;
  private readonly conversationService: ConversationService;
  private readonly publisher: EventPublisher;

  constructor(
    storage: StorageAdapter,
    piService: PiService,
    eventService: EventService,
    eventHub: EventHub,
    conversationService: ConversationService,
  ) {
    this.storage = storage;
    this.piService = piService;
    this.conversationService = conversationService;
    this.publisher = new EventPublisher(eventService, eventHub);
  }

  /**
   * Creates a threaded-conversation document's single root Thread (FR-001/FR-003/FR-004). Only
   * ever called once, from `DocumentService.create()`'s `documentType: 'thread'` branch — per
   * data-model.md's validation rule, exactly one such row exists per document.
   */
  createRoot(documentId: string): ConversationRow {
    const document = this.storage.getDocument(documentId);
    if (!document) {
      throw new DocumentNotFoundError(`Document not found: ${documentId}`);
    }
    const now = new Date().toISOString();
    return this.storage.createConversation({
      id: newId('conv'),
      documentId,
      parentId: null,
      name: 'Thread',
      kind: 'thread-root',
      // One shared file per threaded-conversation document (research.md R1) — a placeholder path
      // corrected once Pi actually names the file, exactly like canvas Main's own placeholder
      // (`PiService.prepareThreadSession`'s `actualPath` correction).
      piSessionPath: join(document.piSessionDir, 'thread-tree.jsonl'),
      status: 'idle',
      errorMessage: null,
      isPrimary: false,
      isCurrentMain: false,
      contextRevision: document.currentRevision,
      branchDepth: 0,
      seedSelection: null,
      forkedFromMessageId: null,
      piLeafEntryId: null,
      doneAt: null,
      seedExcerptText: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });
  }

  /**
   * Branches a new Thread from a highlighted passage in an earlier, non-tip message of
   * `parentThreadId` (FR-005/FR-005a/FR-006/FR-007). The new Thread shares the parent's own Pi
   * session file — a genuine leaf-repositioned branch of the same tree (research.md R1), not an
   * independently forked session — seeded with the highlighted excerpt as its own first message.
   */
  branchFromHighlight(request: BranchFromHighlightRequest): ConversationDto {
    const parent = this.getThreadOrThrow(request.parentThreadId);
    const document = this.storage.getDocument(parent.documentId);
    if (!document) throw new DocumentNotFoundError('Document not found');

    const appMessages = buildConversationMessages(this.storage, parent.id);
    const anchorIndex = appMessages.findIndex((m) => m.id === request.anchorMessageId);
    if (anchorIndex === -1) {
      throw new InvalidHighlightError(`Message not found: ${request.anchorMessageId}`);
    }
    const anchorMessage = appMessages[anchorIndex]!;
    // Compared post-Markdown-normalization, not as a raw substring check — a highlight is captured
    // from the message bubble's *rendered* DOM (MessageBubble.vue), where Markdown syntax has
    // already become real HTML elements. See `normalizeForHighlightMatch`'s doc comment.
    if (
      !normalizeForHighlightMatch(anchorMessage.text).includes(
        normalizeForHighlightMatch(request.highlightedText),
      )
    ) {
      throw new InvalidHighlightError('Highlighted text was not found in the anchor message');
    }
    const tip = appMessages.at(-1);
    if (tip && tip.id === request.anchorMessageId) {
      throw new AnchorIsTipError("Cannot branch from a thread's current tip message");
    }

    const settings = this.storage.getSettings();
    const branchDepth = parent.branchDepth + 1;
    if (branchDepth > settings.maxConversationDepth) {
      throw new MaxConversationDepthExceededError(
        `Cannot branch beyond conversation depth ${settings.maxConversationDepth}.`,
        settings.maxConversationDepth,
        branchDepth,
      );
    }

    const piLeafEntryId = this.piService.resolveThreadAnchorEntryId(
      parent,
      appMessages,
      request.anchorMessageId,
    );

    const now = new Date().toISOString();
    const name =
      request.name ?? this.dedupeName(document.id, deriveBranchName('', request.highlightedText));

    const row = this.storage.createConversation({
      id: newId('conv'),
      documentId: document.id,
      parentId: parent.id,
      name,
      kind: 'thread-branch',
      piSessionPath: parent.piSessionPath,
      status: 'idle',
      errorMessage: null,
      isPrimary: false,
      isCurrentMain: false,
      contextRevision: document.currentRevision,
      branchDepth,
      seedSelection: null,
      forkedFromMessageId: request.anchorMessageId,
      piLeafEntryId,
      doneAt: null,
      seedExcerptText: request.highlightedText,
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
      seedSelection: null,
    });

    // Reuses `ConversationService.send`'s own `isSeed: true` path (publishes the seed as an
    // ordinary `message_completed` event, then dispatches to `PiService.seedThreadSession` since
    // `row.kind` is thread-*) rather than duplicating that publish-then-deliver sequence here —
    // fire-and-forget, matching `sendBranchSeedMessage`'s own convention: the branch already
    // exists and its own HTTP response has already returned by the time this settles or fails.
    void this.conversationService
      .send(row.id, buildThreadBranchSeedMessage(request.highlightedText), { isSeed: true })
      .catch(() => {});

    return toConversationDto(this.storage, row, document.currentRevision, '');
  }

  /**
   * Marks a Thread done — a non-destructive, reversible visibility flag (FR-008/FR-009), refused
   * while any of its proposals are still unresolved (FR-010, research.md R3's shared guard with
   * `ConversationService.close()`).
   */
  markDone(threadId: string): { threadId: string; doneAt: string } {
    const thread = this.getThreadOrThrow(threadId);
    const pendingEditIds = getPendingStagedEditIds(this.storage, threadId);
    if (pendingEditIds.length > 0) {
      throw new PendingEditsBlockDoneError(
        `Cannot mark thread done while ${pendingEditIds.length} proposal(s) are pending`,
        pendingEditIds,
      );
    }
    const doneAt = new Date().toISOString();
    this.storage.updateConversation(threadId, { doneAt, updatedAt: doneAt });
    this.publisher.publish(thread.documentId, threadId, 'conversation_done_changed', { doneAt });
    return { threadId, doneAt };
  }

  /** Clears a Thread's done state (FR-009) — a no-op 200 if already active. */
  reopen(threadId: string): { threadId: string; doneAt: null } {
    const thread = this.getThreadOrThrow(threadId);
    if (thread.doneAt !== null) {
      this.storage.updateConversation(threadId, {
        doneAt: null,
        updatedAt: new Date().toISOString(),
      });
    }
    this.publisher.publish(thread.documentId, threadId, 'conversation_done_changed', {
      doneAt: null,
    });
    return { threadId, doneAt: null };
  }

  private getThreadOrThrow(threadId: string): ConversationRow {
    const thread = this.storage.getConversation(threadId);
    if (!thread || (thread.kind !== 'thread-root' && thread.kind !== 'thread-branch')) {
      throw new ConversationNotFoundError(`Thread not found: ${threadId}`);
    }
    return thread;
  }

  /** Same disambiguation convention as `ConversationService`'s own (private) dedupe — kept as a
   *  small local copy rather than a shared export, since the two operate on unrelated name pools
   *  (Threads vs. canvas conversations never mix in one document, data-model.md). */
  private dedupeName(documentId: string, name: string): string {
    const existingNames = new Set(this.storage.listAllConversations(documentId).map((c) => c.name));
    if (!existingNames.has(name)) return name;

    let suffix = 2;
    let candidate = `${name} (${suffix})`;
    while (existingNames.has(candidate)) {
      suffix += 1;
      candidate = `${name} (${suffix})`;
    }
    return candidate;
  }
}
