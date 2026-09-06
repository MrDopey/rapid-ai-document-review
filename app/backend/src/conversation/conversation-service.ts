import { dirname, join } from 'node:path';
import type {
  CloseConversationResponse,
  ConversationDto,
  CreateConversationRequest,
  GetConversationResponse,
  ListConversationsResponse,
  MessageDto,
  RefreshSendResponse,
  ReviewConversationResponse,
  SendMessageResponse,
} from '@rapid-ai-document-review/shared/contracts/http';
import { computeIsToolCallCarrier } from '@rapid-ai-document-review/shared/domain';
import type { AutomergeStoreHolder } from '../document/automerge-store-holder.ts';
import { DocumentNotFoundError } from '../document/document-service.ts';
import { logger } from '../logging.ts';
import { newId } from '../ids.ts';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import { EventPublisher } from '../events/event-publisher.ts';
import type { RunBuffer } from '../events/run-buffer.ts';
import type { PiService } from '../pi/pi-service.ts';
import type { TurnRunner } from '../pi/turn-runner.ts';
import type { ConversationRow, SeedSelection, StorageAdapter } from '../storage/storage-adapter.ts';
import { toConversationDto, toConversationDtos } from './conversation-mapper.ts';
import { toStagedEditDto } from '../edit/edit-mapper.ts';
import {
  buildBranchSeedMessage,
  buildMainSeedMessage,
  buildSelectionOnlySeedMessage,
  deriveBranchName,
  extractSeedExcerpt,
} from './seed-excerpt.ts';
import type { ConcurrencyLimiter } from './concurrency-limiter.ts';
import type { PrimaryService } from './primary-service.ts';
import type { ConversationFoldService } from './conversation-fold-service.ts';
import type { ConversationReviewService } from './conversation-review-service.ts';

export class ConversationNotFoundError extends Error {}
export class ConversationClosedError extends Error {}
export class ConversationNotErroredError extends Error {}
export class ConversationNotClosedError extends Error {}
export class ConversationNotEmptyError extends Error {}
export class AgentUnavailableError extends Error {}
/** Shared shape for "a branch/refresh would exceed a configured depth limit" (FR-*): both
 *  `MaxConversationDepthExceededError` and `MaxEditingDepthExceededError` carry the identical
 *  `{limit, attemptedDepth}` pair — the only thing distinguishing them is which limit was hit,
 *  which callers (conversations.ts's error-mapping table) still discriminate via `instanceof` on
 *  the two thin subclasses below, so their existing catch-block behavior is unaffected. */
export class DepthExceededError extends Error {
  readonly limit: number;
  readonly attemptedDepth: number;

  constructor(message: string, limit: number, attemptedDepth: number) {
    super(message);
    this.limit = limit;
    this.attemptedDepth = attemptedDepth;
  }
}
export class MaxConversationDepthExceededError extends DepthExceededError {}
export class MaxEditingDepthExceededError extends DepthExceededError {}
export class PendingEditsBlockCloseError extends Error {
  readonly pendingEditIds: string[];

  constructor(message: string, pendingEditIds: string[]) {
    super(message);
    this.pendingEditIds = pendingEditIds;
  }
}
/**
 * Guard for an operation that requires a conversation to not be actively `working` (e.g. closing
 * it) — specs/006-archivable-main-conversation. Mapped to 409/`CONVERSATION_BUSY` in
 * api/http/conversations.ts's `handleConversationError` dispatch table.
 */
export class ConversationBusyError extends Error {}

export interface PaginationOptions {
  cursor?: string;
  limit: number;
}

interface UserMessageEventData {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string | null;
  /**
   * True only for a `role: 'user'` message this service injected itself (a branch's auto-seed
   * message on the "Branch (New)"/"Branch (Main)" paths — see `branch()` below), as opposed to one
   * the user genuinely typed and sent. Absent/false/undefined on every other message, including
   * every `role: 'assistant'` one. Exists solely so `discardIfEmpty`'s "empty" check
   * (`hasUserSentMessage`) can tell an auto-injected seed apart from a real user reply that reads
   * identically otherwise (same `role: 'user'` shape) — it is never surfaced in `MessageDto`/the
   * HTTP contract, since the UI has no reason to render a seed message any differently.
   */
  isSeed?: boolean;
}

/**
 * Conversation lifecycle for US2: ensuring Main exists, sending messages through the
 * concurrency limiter and PiService, retrying a failed turn, and reading conversation lists/
 * detail. Branching, Primary and edit workflows (US3+) extend this without rewriting it —
 * `getAll`'s `isStale`/`canEdit`/`canBranch`/`pendingEditCount` are already server-computed via
 * `toConversationDto`, which US3+ deepens rather than replaces.
 */
export class ConversationService {
  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly runBuffer: RunBuffer;
  private readonly piService: PiService;
  private readonly concurrencyLimiter: ConcurrencyLimiter;
  private readonly automerge: AutomergeStoreHolder;
  private readonly primaryService: PrimaryService;
  private readonly publisher: EventPublisher;
  private readonly turnRunner: TurnRunner;
  private readonly foldService: ConversationFoldService;
  private readonly reviewService: ConversationReviewService;

  constructor(
    storage: StorageAdapter,
    eventService: EventService,
    eventHub: EventHub,
    runBuffer: RunBuffer,
    piService: PiService,
    concurrencyLimiter: ConcurrencyLimiter,
    automerge: AutomergeStoreHolder,
    primaryService: PrimaryService,
    turnRunner: TurnRunner,
    foldService: ConversationFoldService,
    reviewService: ConversationReviewService,
  ) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.runBuffer = runBuffer;
    this.piService = piService;
    this.concurrencyLimiter = concurrencyLimiter;
    this.automerge = automerge;
    this.primaryService = primaryService;
    this.publisher = new EventPublisher(eventService, eventHub);
    this.turnRunner = turnRunner;
    this.foldService = foldService;
    this.reviewService = reviewService;
  }

  /**
   * Idempotent: creates the Main conversation for `documentId` only if one doesn't exist yet.
   * Only the newly-created branch seeds the document as Main's first message (`seedMain` below)
   * — the early `return existing` above means an already-existing Main is never re-seeded, e.g.
   * on the defensive startup call in server.ts.
   */
  ensureMain(documentId: string): ConversationRow {
    const existing = this.storage.getMainConversation(documentId);
    if (existing) return existing;

    const document = this.storage.getDocument();
    if (!document || document.id !== documentId) {
      throw new DocumentNotFoundError(`Document not found: ${documentId}`);
    }
    const now = new Date().toISOString();
    const row = this.storage.createConversation({
      id: newId('conv'),
      documentId,
      parentId: null,
      name: 'Main',
      kind: 'main',
      piSessionPath: join(document.piSessionDir, 'main.jsonl'),
      status: 'idle',
      errorMessage: null,
      isPrimary: true,
      isCurrentMain: true,
      contextRevision: document.currentRevision,
      branchDepth: 0,
      seedSelection: null,
      forkedFromMessageId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });

    this.seedMain(row.id, document.title, document.currentRevision, this.automerge.get().getContent());

    return row;
  }

  /**
   * Delivers the document under review as a brand-new Main conversation's first message, so the
   * agent has it in message history from the start rather than only reachable via the on-demand
   * `read_document` tool (document-tools.ts). Fire-and-forget through the ordinary `send()` path,
   * same convention as `branch()`/`review()`'s seed messages above: it appears in the transcript
   * as a normal `role: 'user'` message and its own progress/failure surfaces over the event
   * stream, never blocking the caller (a document-creation or startup-recovery call, neither of
   * which should wait on a full agent turn). Called once, at Main-creation time, by both
   * `ensureMain` above and `DocumentService.create` (which builds Main directly rather than
   * through `ensureMain`, for construction-order reasons — see server.ts).
   */
  seedMain(conversationId: string, documentTitle: string, revision: number, content: string): void {
    const seedMessage = buildMainSeedMessage(documentTitle, revision, content);
    void this.send(conversationId, seedMessage).catch((err) => {
      // `event: 'agent_error'` — same reasoning as branch()'s/review()'s seed-message catch above.
      logger.warn(
        { event: 'agent_error', conversationId, err: err instanceof Error ? err.message : String(err) },
        'failed to deliver main seed message',
      );
    });
  }

  /**
   * Startup recovery (FR-039a): an agent operation that was in flight when the application
   * stopped is never resumed — its conversation is instead marked `errored` with the interruption
   * visible to the user, who can retry it (FR-038). This is a process-level event, distinct from a
   * client disconnecting while the application keeps running (FR-037), where nothing is ever
   * marked errored. Called once at boot, after Automerge state has been loaded
   * (`DocumentService.loadIfExists`) and before any request is served.
   */
  recoverInterruptedRuns(documentId: string): void {
    const interrupted = this.storage
      .listAllConversations(documentId)
      .filter((conversation) => conversation.status === 'working');

    for (const conversation of interrupted) {
      const errorMessage = 'Interrupted by application restart';
      this.storage.updateConversation(conversation.id, { status: 'errored', errorMessage });
      // No separate log call here: `this.publish` -> `eventService.append` already emits the
      // compliant `{ event: 'conversation_status_changed', documentId, conversationId, sequence }`
      // record (FR-042) — the same pattern `publishUserMessage` relies on below.
      this.publish(documentId, conversation.id, 'conversation_status_changed', {
        status: 'errored',
        previousStatus: 'working',
      });
    }
  }

  getAll(documentId: string, options: PaginationOptions): ListConversationsResponse {
    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError(`Document not found: ${documentId}`);
    const page = this.storage.listConversations(documentId, options);
    const content = this.automerge.get().getContent();
    return {
      currentRevision: document.currentRevision,
      conversations: toConversationDtos(this.storage, page.items, document.currentRevision, content),
      nextCursor: page.nextCursor,
    };
  }

  getOne(conversationId: string): GetConversationResponse {
    const conversation = this.getConversationOrThrow(conversationId);
    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError('Document not found');
    return {
      conversation: toConversationDto(this.storage, conversation, document.currentRevision, this.automerge.get().getContent()),
      messages: this.buildMessages(conversationId),
      stagedEdits: this.storage.listStagedEditsByConversation(conversationId).map(toStagedEditDto),
    };
  }

  /**
   * Renames a conversation's title (narrowly scoped: only `name` ever changes here, unlike
   * `close()`'s lifecycle transition). Deliberately allowed regardless of `status` — closed and
   * errored conversations keep their history readable/findable, and there's no reason a rename
   * (pure metadata, no bearing on `canEdit`/`canBranch`) should be blocked just because the
   * conversation itself no longer accepts new messages. The request body's `name` already arrives
   * trimmed and non-empty (`RenameConversationRequest`'s zod schema), so no further validation is
   * needed here.
   */
  rename(conversationId: string, name: string): ConversationDto {
    const conversation = this.getConversationOrThrow(conversationId);
    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError('Document not found');

    const now = new Date().toISOString();
    const updated = this.storage.updateConversation(conversationId, { name, updatedAt: now });

    this.publish(conversation.documentId, conversationId, 'conversation_renamed', { name });

    return toConversationDto(this.storage, updated, document.currentRevision, this.automerge.get().getContent());
  }

  /**
   * Branches a new conversation from a document selection or from another conversation
   * (FR-011/FR-013). Three creation paths, each with its own seed-message/continuity shape:
   *
   *  - "Branch (New)" (`selection` given, `includeSeedMessage` omitted/false): seeded with the
   *    *full document* plus the highlighted selection (`buildBranchSeedMessage`), and
   *    `forkedFromMessageId` stays `null` — not a fork, no parent message context, no continuity
   *    snippet. The seed message stands in for the missing continuity: the agent gets the whole
   *    document on its own, fresh session.
   *  - "Branch (Main)" (`selection` given, `includeSeedMessage: true`): seeded with *only* the
   *    highlighted selection (`buildSelectionOnlySeedMessage`) — no full document, since
   *    `forkedFromMessageId` is populated here (the parent's last message id) and the resulting
   *    continuity snippet (`ConversationThreadBox.vue`'s `continuityMessages`) already gives the
   *    agent the prior context a full document resend would duplicate.
   *  - Sidebar "Branch this conversation" (no `selection`): no seed message at all — there's no
   *    selection to seed with — but `forkedFromMessageId` is still populated (same as Branch
   *    (Main)), so the continuity snippet renders.
   *
   * Every seed message above is sent fire-and-forget via `sendBranchSeedMessage` (same
   * non-blocking convention as `seedMain`/`review()`), marked `isSeed: true` so it's excluded from
   * `discardIfEmpty`'s "has the user sent anything" check below — an auto-injected seed must never
   * by itself keep an otherwise-untouched branch from being discarded.
   */
  branch(request: CreateConversationRequest): ConversationDto {
    const parent = this.getConversationOrThrow(request.parentConversationId);
    if (parent.status === 'closed') {
      throw new ConversationClosedError('Cannot branch from a closed conversation');
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

    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError('Document not found');

    let seedSelection: SeedSelection | null = null;
    let seedExcerpt = '';
    let documentContent = '';
    if (request.selection) {
      documentContent = this.automerge.get().getContent();
      const { from, to } = request.selection;
      const text = documentContent.slice(from, to);
      seedSelection = { from, to, text };
      // Used only for `deriveBranchName`'s heading search below — the seed *message* sent further
      // down uses the raw selection text directly, not this derived excerpt.
      seedExcerpt = extractSeedExcerpt(documentContent, from, to);
    }

    // Disambiguate only the auto-generated case (FR-014 follow-up): an explicit `request.name` is
    // left exactly as the caller supplied it.
    const autoName = seedSelection ? deriveBranchName(seedExcerpt, seedSelection.text) : 'Branch';
    const name = request.name ?? this.dedupeConversationName(document.id, autoName);
    const now = new Date().toISOString();
    const id = newId('conv');
    const piSessionPath = join(dirname(parent.piSessionPath), `${id}.jsonl`);

    // Message-level fork anchor (005-canvas-conversation-threads): populated when the branch was
    // created from within a conversation (no `selection` given — always gets continuity) or when a
    // selection-anchored branch opted in via `includeSeedMessage` ("Branch (Main)"). A plain
    // selection-anchored branch without that opt-in ("Branch (New)") has no message context to
    // anchor to, so this stays `null` there (the document excerpt in `seedSelection` is its anchor
    // instead).
    const forkedFromMessageId =
      !request.selection || request.includeSeedMessage ? (this.buildMessages(parent.id).at(-1)?.id ?? null) : null;

    const row = this.storage.createConversation({
      id,
      documentId: document.id,
      parentId: parent.id,
      name,
      kind: 'branch',
      piSessionPath,
      status: 'idle',
      errorMessage: null,
      isPrimary: false,
      isCurrentMain: false,
      contextRevision: document.currentRevision,
      branchDepth,
      seedSelection,
      forkedFromMessageId,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });

    this.publish(document.id, row.id, 'conversation_started', {
      conversationId: row.id,
      name: row.name,
      kind: row.kind,
      parentId: row.parentId,
      branchDepth: row.branchDepth,
      contextRevision: row.contextRevision,
      seedSelection: row.seedSelection,
      forkedFromMessageId: row.forkedFromMessageId,
    });

    // Seed message, per path (see this method's doc comment above):
    //  - selection given, no includeSeedMessage opt-in ("Branch (New)"): full document + selection.
    //  - selection given, includeSeedMessage: true ("Branch (Main)"): selection only.
    //  - no selection (sidebar "Branch this conversation"): nothing to send.
    if (seedSelection) {
      const seedMessage = request.includeSeedMessage
        ? buildSelectionOnlySeedMessage(seedSelection.text)
        : buildBranchSeedMessage(document.currentRevision, documentContent, seedSelection.text);
      this.sendBranchSeedMessage(row.id, seedMessage);
    }

    return toConversationDto(this.storage, row, document.currentRevision, documentContent || this.automerge.get().getContent());
  }

  /**
   * Closes a conversation (FR-033/FR-034/FR-035). Refused while any proposal is still `pending`.
   * Closing the Primary conversation clears the designation without transferring it (FR-027a),
   * delegated to `PrimaryService.closeClears` — the single source of truth for every `is_primary`
   * write (US5).
   */
  close(conversationId: string, foldSummaryIntoParent: boolean): CloseConversationResponse {
    const conversation = this.getConversationOrThrow(conversationId);
    if (conversation.status === 'closed') {
      return {
        conversationId,
        status: 'closed',
        summaryFoldedIntoParent: false,
        parentConversationId: conversation.parentId,
      };
    }

    // A conversation whose agent turn produced a still-pending proposal reports that specific,
    // more actionable reason (PendingEditsBlockCloseError) even though the turn that created the
    // proposal may not have fully settled back to `idle` yet (the tool call that stages the edit
    // completes, and is externally observable via `listStagedEditsByConversation`, slightly before
    // the turn's own trailing response finishes streaming and flips status back) — checked before
    // the general `working` guard below so this more specific case always wins.
    const pending = this.storage
      .listStagedEditsByConversation(conversationId)
      .filter((e) => e.status === 'pending');
    if (pending.length > 0) {
      throw new PendingEditsBlockCloseError(
        `Cannot close conversation while ${pending.length} proposal(s) are pending`,
        pending.map((e) => e.id),
      );
    }

    // Guards against closing while a turn is in flight (specs/006-archivable-main-conversation) —
    // applies to every kind, checked after the more specific pending-edits guard above.
    if (conversation.status === 'working') {
      throw new ConversationBusyError('Cannot close a conversation while it is working');
    }

    // Archiving Main (specs/006-archivable-main-conversation, US1): closing Main atomically
    // replaces it with a fresh, current, freshly-seeded Main in the same slot rather than leaving
    // the document without a usable one (FR-002/FR-003) — see `archiveMain` below.
    if (conversation.kind === 'main') {
      return this.archiveMain(conversation.documentId);
    }

    const now = new Date().toISOString();
    const wasPrimary = conversation.isPrimary;
    this.storage.updateConversation(conversationId, { status: 'closed', closedAt: now });

    const parent = conversation.parentId ? this.storage.getConversation(conversation.parentId) : null;
    const willFold = foldSummaryIntoParent && parent !== null && parent.status !== 'closed';

    this.publish(conversation.documentId, conversationId, 'conversation_closed', {
      closedAt: now,
      summaryFoldedIntoParent: willFold,
      parentConversationId: conversation.parentId,
    });

    // Closing the Primary conversation leaves the document with none — never transferred
    // implicitly (data-model.md §5, FR-027a).
    if (wasPrimary) {
      this.primaryService.closeClears(conversationId);
    }

    if (!(willFold && parent)) {
      // Nothing further will ever call `getOrCreateSession` for this now-closed
      // conversation (no fold summary is pending), so its cached Pi session can be evicted right
      // away instead of sitting in `PiService.sessions` for the rest of the process's lifetime.
      // When a fold *is* pending, `foldSummaryIntoParent` below evicts it once that flow — the
      // only remaining reader of this conversation's own session — has finished with it.
      this.piService.evictSession(conversationId);
    }

    if (willFold && parent) {
      // Fire-and-forget (research R1, FR-034): asking Pi for the synopsis half of the fold
      // summary is a genuine model call and must never block this HTTP response — `close()`
      // already returned its status flip above. `conversation_summary_folded` is emitted only
      // once the summary has actually been generated *and* delivered into the parent's session,
      // never at close time (websocket-events.md), and the fold is dropped silently if the
      // parent has itself closed by the time delivery would occur (FR-034a).
      void this.foldService.foldSummaryIntoParent(conversation, parent.id).catch((err) => {
        // `event: 'agent_error'` — the failure is in a Pi session call (deliverFoldSummary), the
        // only vocabulary term that fits a Pi-side failure with no other event of its own (FR-042).
        logger.warn(
          {
            event: 'agent_error',
            documentId: conversation.documentId,
            conversationId: conversation.id,
            parentConversationId: parent.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'failed to fold summary into parent; parent conversation continues unaffected',
        );
      });
    }

    return {
      conversationId,
      status: 'closed',
      summaryFoldedIntoParent: willFold,
      parentConversationId: conversation.parentId,
    };
  }

  /**
   * Archives the current Main and atomically replaces it with a fresh, current, freshly-seeded
   * Main in the same slot (specs/006-archivable-main-conversation, US1/FR-002/FR-003/FR-007/
   * FR-008). Invoked from `close()`'s `kind === 'main'` branch above — no new HTTP route or WS
   * event type, the existing `POST /api/conversations/:id/close` and `conversation_closed`/
   * `conversation_started` events are reused verbatim. The old-Main-closed and new-Main-created
   * writes are wrapped in a single `this.storage.transaction` so the document is never observably
   * left with zero or more than one `isCurrentMain` row for any caller reading between the two
   * writes (research.md §5) — everything after the transaction (Primary clearing, event
   * publishing, Pi-session eviction, seeding) is a post-commit side effect, mirroring `close()`'s
   * own DB-write-then-publish ordering above.
   */
  private archiveMain(documentId: string): CloseConversationResponse {
    const document = this.storage.getDocument();
    if (!document || document.id !== documentId) {
      throw new DocumentNotFoundError(`Document not found: ${documentId}`);
    }
    const oldMain = this.storage.getMainConversation(documentId);
    if (!oldMain) {
      throw new ConversationNotFoundError(`Main conversation not found for document: ${documentId}`);
    }

    const now = new Date().toISOString();
    const wasPrimary = oldMain.isPrimary;
    const newMainId = newId('conv');

    this.storage.transaction(() => {
      this.storage.updateConversation(oldMain.id, { status: 'closed', closedAt: now, isCurrentMain: false });
      this.storage.createConversation({
        id: newMainId,
        documentId,
        parentId: null,
        name: 'Main',
        kind: 'main',
        piSessionPath: join(document.piSessionDir, `main-${newMainId}.jsonl`),
        status: 'idle',
        errorMessage: null,
        isPrimary: false,
        isCurrentMain: true,
        contextRevision: document.currentRevision,
        branchDepth: 0,
        seedSelection: null,
        forkedFromMessageId: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      });
    });

    // Archiving the Primary Main clears Primary rather than transferring it (FR-007) — same rule
    // `close()` already applies to any Primary conversation, reused verbatim.
    if (wasPrimary) {
      this.primaryService.closeClears(oldMain.id);
    }

    this.publish(documentId, oldMain.id, 'conversation_closed', {
      closedAt: now,
      summaryFoldedIntoParent: false,
      parentConversationId: oldMain.parentId,
    });
    this.publish(documentId, newMainId, 'conversation_started', {
      conversationId: newMainId,
      name: 'Main',
      kind: 'main',
      parentId: null,
      branchDepth: 0,
      contextRevision: document.currentRevision,
      seedSelection: null,
      forkedFromMessageId: null,
    });

    // Same reasoning as `close()`'s own unconditional eviction above: nothing will ever call
    // `getOrCreateSession` for the now-archived Main again (no fold-into-parent concept applies to
    // Main), so its cached Pi session can be evicted right away.
    this.piService.evictSession(oldMain.id);

    // FR-008: the replacement Main is seeded with the document's current content, same as any
    // brand-new Main (`ensureMain` above).
    this.seedMain(newMainId, document.title, document.currentRevision, this.automerge.get().getContent());

    return {
      conversationId: oldMain.id,
      status: 'closed',
      summaryFoldedIntoParent: false,
      parentConversationId: oldMain.parentId,
    };
  }

  /**
   * 005-canvas-conversation-threads follow-up: physically discards a branch placeholder
   * conversation that was created (via either "Branch" toolbar button, or the sidebar's "Branch
   * this conversation") and then never used — the "opened a branch, sent nothing, changed my
   * mind" case, distinct from `close()`'s FR-033 lifecycle (which the user explicitly confirms,
   * and which leaves the row around, read-only, possibly folding a summary into its parent).
   * Leaving an untouched branch's row around forever would just be permanent clutter, so this
   * removes it outright rather than soft-closing it.
   *
   * Requires every one of:
   *  - `kind === 'branch'` — Main (`ensureMain`'s single per-document row) and `review`
   *    conversations (which always start with a real, non-seed-marked seed message, so they could
   *    never satisfy the next condition anyway) are never discarded this way.
   *  - No message the *user* has sent yet (`hasUserSentMessage`) — this is not the same as zero
   *    stored messages: `branch()` above auto-sends its own seed message (`isSeed: true`) on both
   *    the "Branch (New)" and "Branch (Main)" paths, and that alone must not count as activity that
   *    keeps the placeholder around. Only once the user sends their own first message (real
   *    `role: 'user'`, `isSeed` false/absent) does the branch survive a close.
   *  - No other conversation has since branched off *it* — deleting this row would either orphan
   *    that child's `parent_id` or simply be refused outright by the FK on `conversation.parent_id`.
   *
   * Anything short of that throws `ConversationNotEmptyError` rather than silently no-op-ing, so a
   * caller (the frontend's own precondition check can itself race against a second client sending
   * a message a moment earlier) gets an explicit signal rather than a false "discarded: true".
   */
  discardIfEmpty(conversationId: string): { conversationId: string; discarded: true } {
    const conversation = this.getConversationOrThrow(conversationId);
    if (conversation.kind !== 'branch') {
      throw new ConversationNotEmptyError('Only a branch conversation can be discarded this way');
    }
    if (this.hasUserSentMessage(conversationId)) {
      throw new ConversationNotEmptyError('Conversation has messages and cannot be discarded');
    }
    const hasChildren = this.storage
      .listAllConversations(conversation.documentId)
      .some((c) => c.parentId === conversationId);
    if (hasChildren) {
      throw new ConversationNotEmptyError('Conversation has its own branches and cannot be discarded');
    }

    // Same reasoning as `close()`'s own wasPrimary handling: never transferred implicitly
    // (FR-027a) — just cleared, since the conversation is about to stop existing entirely.
    if (conversation.isPrimary) {
      this.primaryService.closeClears(conversationId);
    }
    // No pending turn/session work is possible on a zero-message conversation, but eviction is
    // cheap and idempotent — matches `close()`'s own unconditional-when-safe eviction above.
    this.piService.evictSession(conversationId);
    this.storage.deleteConversation(conversationId);

    return { conversationId, discarded: true };
  }

  /**
   * FR-036: an independent review of a closed conversation and its branches. Validates the target
   * conversation/document here (so thrown errors stay exactly where callers already expect them),
   * delegating the rest — building the reviewed-conversation-id set, the transcript, the new
   * `kind: 'review'` conversation row, and its seed message — to `ConversationReviewService`.
   */
  review(conversationId: string): ReviewConversationResponse {
    const target = this.getConversationOrThrow(conversationId);
    if (target.status !== 'closed') {
      throw new ConversationNotClosedError('Only a closed conversation can be reviewed');
    }

    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError('Document not found');

    return this.reviewService.review(target, document, {
      sendMessage: (id, message) => this.send(id, message),
      buildMessages: (id) => this.buildMessages(id),
    });
  }

  async send(conversationId: string, message: string, options: { isSeed?: boolean } = {}): Promise<SendMessageResponse> {
    const conversation = this.getConversationOrThrow(conversationId);
    if (conversation.status === 'closed') {
      throw new ConversationClosedError('Conversation is closed');
    }

    // Recorded directly (rather than relying on Pi to report the user's own message back
    // through its event stream) so message history and retry are well-defined regardless of
    // exactly which lifecycle events a given Pi SDK version emits for the prompt it was given.
    this.publishUserMessage(conversation.documentId, conversationId, message, options.isSeed ?? false);

    // A seed message (branch's/Main's auto-injected document/selection context, `isSeed: true`)
    // is stored above so it's part of the app's own event log for whenever the user's own first
    // message arrives, but must never itself trigger an agent turn — branches are transient/inert
    // until the user sends a real message of their own. Everything below this point
    // (concurrency-limiter admission -> `piService.send`) is what actually starts the model
    // generating a response, so a seed message never falls through into it.
    //
    // It must, however, still reach the underlying Pi session's OWN context — otherwise the
    // model never actually sees the document/selection excerpt the UI displays as if it were part
    // of the conversation: without this call, the branch's real Pi session would only be created
    // lazily on the user's first genuine message, forked from the parent, with the seed content
    // nowhere in it. `piService.seedSession` creates/forks that session right now and hands it the
    // content through a vendor SDK path that persists it into session history without ever calling
    // `session.prompt()` — see its doc comment in pi-service.ts for exactly why that mechanism (not
    // `deliverAs: 'nextTurn'`, used by the fold-summary path) is the right one here. Any failure
    // here is surfaced to this method's caller exactly like a failed `piService.send()` would be —
    // `sendBranchSeedMessage`'s existing fire-and-forget `.catch(...)` (and `seedMain`'s) already
    // logs and swallows it the same way.
    if (options.isSeed) {
      await this.piService.seedSession(conversation, message);
      return { accepted: true, queued: false, contextRevision: conversation.contextRevision };
    }

    // Shared turn-starting wiring (EventBridge + ConcurrencyLimiter admission) — see
    // TurnRunner's doc comment for why this is a shared collaborator rather than duplicated here.
    const { queued, immediateRun } = this.turnRunner.start(conversation, message);

    if (!queued && immediateRun) {
      try {
        await immediateRun;
      } catch (err) {
        // Bridge already recorded agent_error + errored status; this rejection additionally
        // fails the HTTP call itself since the failure happened before the run was even queued
        // (http-api.md: "AGENT_UNAVAILABLE (502) if the model call fails immediately").
        throw new AgentUnavailableError(err instanceof Error ? err.message : String(err));
      }
    }

    return { accepted: true, queued, contextRevision: conversation.contextRevision };
  }

  /**
   * Refreshes a conversation's context to the current document revision, then sends `message`
   * through the identical `send()` path (FR-018) — no separate concurrency-limiter/PiService
   * wiring is duplicated here. Refresh participates in the edit workflow even though the
   * conversation may still chat normally past that depth (FR-026, http-api.md), so it is blocked
   * the same way `propose_document_edit` is.
   *
   * No message is injected into the Pi session to announce the refresh: `read_document`
   * (document-tools.ts) already serves content keyed off `conversation.context_revision`, so
   * simply advancing that column here is sufficient for the *next* `read_document` call — made
   * during the `send()` below — to see the newer document (agent-tools.md §8).
   */
  async refreshAndSend(conversationId: string, message: string): Promise<RefreshSendResponse> {
    const conversation = this.getConversationOrThrow(conversationId);
    if (conversation.status === 'closed') {
      throw new ConversationClosedError('Conversation is closed');
    }

    const settings = this.storage.getSettings();
    if (conversation.branchDepth > settings.maxEditingDepth) {
      throw new MaxEditingDepthExceededError(
        `Cannot refresh context beyond editing depth ${settings.maxEditingDepth}.`,
        settings.maxEditingDepth,
        conversation.branchDepth,
      );
    }

    const document = this.storage.getDocument();
    if (!document) throw new DocumentNotFoundError('Document not found');

    const previousContextRevision = conversation.contextRevision;
    const contextRevision = document.currentRevision;

    // "Edits relevant to that conversation" (FR-018) means this conversation's own pending
    // proposals — never another conversation's (http-api.md §POST /refresh-send).
    const includedStagedEditIds = this.storage
      .listStagedEditsByConversation(conversationId)
      .filter((edit) => edit.status === 'pending')
      .map((edit) => edit.id);

    this.storage.updateConversation(conversationId, { contextRevision });

    this.publish(document.id, conversationId, 'conversation_context_refreshed', {
      contextRevision,
      previousContextRevision,
      includedStagedEditIds,
    });

    const result = await this.send(conversationId, message);

    return {
      accepted: result.accepted,
      queued: result.queued,
      contextRevision,
      previousContextRevision,
      includedStagedEditIds,
    };
  }

  /**
   * Re-sends the message that produced a failed turn, against the conversation's preserved
   * history (FR-038). Idempotency on redelivered tool calls (FR-040) is what prevents this from
   * double-applying anything a pre-failure tool call had already done.
   */
  async retry(conversationId: string): Promise<{ accepted: boolean; status: 'working' }> {
    const conversation = this.getConversationOrThrow(conversationId);
    if (conversation.status !== 'errored') {
      throw new ConversationNotErroredError('Conversation is not in an errored state');
    }
    const lastUserMessage = this.getLastUserMessageText(conversationId);
    await this.send(conversationId, lastUserMessage);
    return { accepted: true, status: 'working' };
  }

  /**
   * Auto-generated branch names (`deriveBranchName`, derived from the seeded selection's
   * heading/leading words) just truncate the passage, so branching the same or adjacent text
   * repeatedly can produce multiple conversations with identical-looking names. When `name`
   * collides with an existing conversation in the same document, appends the lowest-numbered
   * " (N)" suffix (starting at 2) not already in use, so sidebar entries stay distinguishable. A
   * non-colliding name (the common case) is returned untouched. Explicit names (`request.name`)
   * never reach this method, so they're never deduped.
   */
  private dedupeConversationName(documentId: string, name: string): string {
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

  private getConversationOrThrow(conversationId: string): ConversationRow {
    const conversation = this.storage.getConversation(conversationId);
    if (!conversation) {
      throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
    }
    return conversation;
  }

  private buildMessages(conversationId: string): MessageDto[] {
    return this.storage
      .listEventsByConversation(conversationId)
      .filter((row) => row.eventType === 'message_completed')
      .map((row) => {
        const data = row.data as UserMessageEventData;
        return {
          id: data.messageId,
          role: data.role,
          text: data.text,
          reasoning: data.reasoning,
          isToolCallCarrier: computeIsToolCallCarrier(data),
          toolCalls: [],
          createdAt: row.createdAt,
        };
      })
      // Defensive: a persisted event can be missing `messageId`/`role`/`text` entirely (e.g., an older
      // row recorded before validation existed, or a future bug in whatever recorded it). `MessageDto`
      // requires all three, so one bad row would otherwise fail `GetConversationResponse.parse` on the
      // client and blank out this conversation's *entire* history rather than just the one row —
      // dropping it here is strictly better than surfacing a response the client can't parse at all.
      .filter((message) => Boolean(message.id) && Boolean(message.role) && typeof message.text === 'string');
  }

  /**
   * `discardIfEmpty`'s "empty" test: whether the *user* has genuinely sent a message in this
   * conversation, as opposed to only having received a branch's own auto-injected seed message
   * (`role: 'user'`, `isSeed: true` — see `sendBranchSeedMessage`/`branch()`). Reads the raw event
   * log directly rather than `buildMessages` (whose `MessageDto` mapping doesn't carry `isSeed` —
   * that flag is intentionally never surfaced over the HTTP contract) so a seed message is filtered
   * out here without needing to expose it to the client at all.
   */
  private hasUserSentMessage(conversationId: string): boolean {
    return this.storage
      .listEventsByConversation(conversationId)
      .filter((row) => row.eventType === 'message_completed')
      .some((row) => {
        const data = row.data as UserMessageEventData;
        return data.role === 'user' && !data.isSeed;
      });
  }

  private getLastUserMessageText(conversationId: string): string {
    const events = this.storage.listEventsByConversation(conversationId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const row = events[i]!;
      if (row.eventType !== 'message_completed') continue;
      const data = row.data as UserMessageEventData;
      if (data.role === 'user') return data.text;
    }
    throw new Error(`No prior user message found to retry for conversation ${conversationId}`);
  }

  private publish(documentId: string, conversationId: string | null, type: string, data: unknown): void {
    this.publisher.publish(documentId, conversationId, type, data);
  }

  private publishUserMessage(documentId: string, conversationId: string, text: string, isSeed = false): void {
    const data: UserMessageEventData = { messageId: newId('msg'), role: 'user', text, reasoning: null, isSeed };
    // No separate log here: `EventPublisher.publish` -> `eventService.append` already emits the
    // compliant `{ event: 'message_completed', documentId, conversationId, sequence }` record
    // (FR-042) — a second one under a name outside the closed vocabulary would be pure duplication.
    this.publisher.publish(documentId, conversationId, 'message_completed', data);
  }

  /**
   * Fire-and-forget delivery of a branch's auto-seed message (`branch()` below), through the
   * ordinary `send()` path with `isSeed: true` so `discardIfEmpty` can later tell it apart from a
   * genuine user reply. Same non-blocking/log-and-swallow convention as `seedMain`'s and
   * `review()`'s own seed sends: the branch already exists and its own HTTP response has already
   * returned by the time this settles or fails.
   */
  private sendBranchSeedMessage(conversationId: string, message: string): void {
    void this.send(conversationId, message, { isSeed: true }).catch((err) => {
      // `event: 'agent_error'` — same reasoning as seedMain's/review()'s seed-message catch blocks.
      logger.warn(
        { event: 'agent_error', conversationId, err: err instanceof Error ? err.message : String(err) },
        'failed to deliver branch seed message',
      );
    });
  }
}
