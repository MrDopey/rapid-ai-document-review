import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { DocumentDto, ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import { config } from '../config.ts';
import { logger } from '../logging.ts';
import { newId } from '../ids.ts';
import type { StorageAdapter } from '../storage/storage-adapter.ts';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import { EventPublisher } from '../events/event-publisher.ts';
import { toConversationDto } from '../conversation/conversation-mapper.ts';
import type { ConversationService } from '../conversation/conversation-service.ts';
import type { PrimaryMutex } from '../pi/primary-mutex.ts';
import { AutomergeStore } from './automerge-store.ts';
import type { AutomergeStoreHolder } from './automerge-store-holder.ts';
import type { RevisionService } from './revision-service.ts';

export interface DocumentChangeSpec {
  from: number;
  to: number;
  insert: string;
}

export class DocumentAlreadyExistsError extends Error {}
export class DocumentNotFoundError extends Error {}

/**
 * Thrown by `applyChanges` when the client's `baseRevision` no longer matches
 * `currentRevision`: the `{from, to, insert}` character offsets in `changes` were computed by the
 * frontend against whatever text it held locally, and the document has since moved on (e.g. a
 * Primary conversation's agent edit landed while this manual edit was in flight, or another
 * browser tab wrote first). Automerge's CRDT convergence guarantees do not make a numeric offset
 * computed against old text keep naming the same logical span once the document's shape has
 * changed, so this is a hard reject, not a merge attempt; the caller is expected to refetch the
 * current document and let the user redo their edit.
 *
 * No route currently has a dedicated `instanceof` catch clause for this error (unlike
 * `DocumentAlreadyExistsError`/`DocumentNotFoundError` in `api/http/document.ts`), so it propagates
 * to Fastify's default error handler. That handler reads a thrown error's own `status`/`statusCode`
 * property (see `fastify/lib/error-handler.js`'s `setErrorHeaders`) to pick the response status even
 * with no custom handler registered, so the `statusCode` below is enough on its own to surface this
 * as an HTTP 409.
 */
export class DocumentOutOfSyncError extends Error {
  readonly statusCode = 409;
  readonly currentRevision: number;

  constructor(message: string, currentRevision: number) {
    super(message);
    this.name = 'DocumentOutOfSyncError';
    this.currentRevision = currentRevision;
  }
}

export interface CreateDocumentResult {
  document: DocumentDto;
  content: string;
  mainConversation: ConversationDto;
}

export interface GetDocumentResult {
  document: DocumentDto;
  content: string;
  eventSequence: number;
}

export interface ApplyChangesResult {
  currentRevision: number;
  revisionCreated: boolean;
}

function toDocumentDto(doc: {
  id: string;
  title: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
}): DocumentDto {
  return {
    id: doc.id,
    title: doc.title,
    currentRevision: doc.currentRevision,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function deriveTitle(content: string, explicit: string | undefined): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const heading = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^#\s+\S/.test(l));
  if (heading) {
    return heading.replace(/^#\s+/, '').trim();
  }
  return 'Untitled';
}

/**
 * The document's authoritative service — the only place manual edits and creation touch the
 * Automerge doc (Constitution Principle I). Agent-originated changes flow through EditService,
 * which shares the same AutomergeStoreHolder.
 */
export class DocumentService {
  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly automerge: AutomergeStoreHolder;
  private readonly revisionService: RevisionService;
  private readonly primaryMutex: PrimaryMutex;
  private readonly publisher: EventPublisher;
  // Late-bound (like `RevisionService.setDocumentService`/`PiService.setEditService` above it in
  // server.ts's construction order): `ConversationService` is constructed after `DocumentService`
  // and depends on nothing here, so this breaks what would otherwise be a construction cycle.
  // Used only to seed a brand-new Main conversation's first message with the document (below) —
  // `create()` is only ever called well after server.ts has finished wiring both services.
  private conversationService: ConversationService | null = null;

  constructor(
    storage: StorageAdapter,
    eventService: EventService,
    eventHub: EventHub,
    automerge: AutomergeStoreHolder,
    revisionService: RevisionService,
    primaryMutex: PrimaryMutex,
  ) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.automerge = automerge;
    this.revisionService = revisionService;
    this.primaryMutex = primaryMutex;
    this.publisher = new EventPublisher(eventService, eventHub);
  }

  setConversationService(conversationService: ConversationService): void {
    this.conversationService = conversationService;
  }

  /**
   * Loads Automerge state from storage at startup, if a document already exists (FR-039).
   * `documents.current_revision` is expected to always match its latest `revision` row — kept in
   * sync by `RevisionService.createRevision`'s own write to that column — but a mismatch here
   * would mean a prior crash left the two out of step. This is verified defensively (log-warn, not
   * a thrown error): the application still starts and serves whatever state is actually on disk
   * (Principle I) rather than refusing to boot over a consistency check.
   */
  loadIfExists(): void {
    const doc = this.storage.getDocument();
    if (!doc) return;

    this.automerge.set(AutomergeStore.load(this.storage, doc.id));

    const latestRevision = this.storage.getLatestRevision(doc.id);
    const latestRevisionNumber = latestRevision?.revision ?? 0;
    if (latestRevisionNumber !== doc.currentRevision) {
      logger.warn(
        {
          documentId: doc.id,
          currentRevision: doc.currentRevision,
          latestRevisionRow: latestRevisionNumber,
        },
        'document.currentRevision does not match its latest revision row at startup',
      );
    }
  }

  create(content: string, title?: string): CreateDocumentResult {
    if (this.storage.getDocument()) {
      throw new DocumentAlreadyExistsError('Document already exists');
    }
    const documentId = newId('doc');
    const now = new Date().toISOString();
    const resolvedTitle = deriveTitle(content, title);
    const piSessionDir = join(config.piSessionStoragePath, documentId);

    const documentRow = this.storage.createDocument({
      id: documentId,
      title: resolvedTitle,
      piSessionDir,
      createdAt: now,
      updatedAt: now,
    });

    const store = AutomergeStore.create(this.storage, documentId, content);
    this.automerge.set(store);

    this.publish(documentId, {
      type: 'document_created',
      sequence: null,
      documentId,
      conversationId: null,
      at: now,
      data: { documentId, title: resolvedTitle, revision: 1, content },
    });

    const revisionRow = this.revisionService.createRevision(documentId, {
      source: 'user',
      origin: 'creation',
    });

    const mainConversationRow = this.storage.createConversation({
      id: newId('conv'),
      documentId,
      parentId: null,
      name: 'Main',
      kind: 'main',
      piSessionPath: join(piSessionDir, 'main.jsonl'),
      status: 'idle',
      errorMessage: null,
      isPrimary: true,
      isCurrentMain: true,
      contextRevision: revisionRow.revision,
      branchDepth: 0,
      seedSelection: null,
      forkedFromMessageId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });

    // Feature: inject the document under review as Main's first message, so the agent has it in
    // message history from the start rather than only reachable via `read_document`. Mirrors
    // `ConversationService.ensureMain`'s own call to the same `seedMain` for its (rarer,
    // defensive-only) creation path — see the comment on `conversationService` above for why this
    // is a possibly-null late-bound reference rather than a constructor dependency.
    this.conversationService?.seedMain(mainConversationRow.id, resolvedTitle, revisionRow.revision, content);

    return {
      document: toDocumentDto({ ...documentRow, currentRevision: revisionRow.revision }),
      content,
      mainConversation: toConversationDto(this.storage, mainConversationRow, revisionRow.revision, content),
    };
  }

  get(): GetDocumentResult | null {
    const doc = this.storage.getDocument();
    if (!doc) return null;
    if (!this.automerge.isSet()) {
      this.automerge.set(AutomergeStore.load(this.storage, doc.id));
    }
    return {
      document: toDocumentDto(doc),
      content: this.automerge.get().getContent(),
      eventSequence: this.eventService.getLatestSequence(doc.id),
    };
  }

  renameTitle(title: string): void {
    const doc = this.storage.getDocument();
    if (!doc) throw new DocumentNotFoundError('Document not found');
    this.storage.updateDocumentTitle(doc.id, title, new Date().toISOString());
  }

  /**
   * Called by `RevisionService` (via the late-bound `setDocumentService` wiring in server.ts —
   * mirroring `PiService.setEditService`'s cycle-breaking pattern) after every revision is
   * created, regardless of origin. Computes which non-closed conversations just became stale
   * (FR-016) and emits `conversation_stale` for exactly those.
   *
   * "Just became stale" means this conversation's `context_revision` was exactly caught up
   * immediately before this revision (`contextRevision === currentRevision - 1`) — a conversation
   * already behind by more than one revision was already known stale from an earlier call and is
   * not re-emitted (websocket-events.md: "convenience signal", not a per-revision recount). A
   * conversation is never marked stale by a revision it caused itself: `EditService.applyClean`
   * advances the authoring conversation's own `context_revision` to match before the revision is
   * created, so it can never appear "one behind" its own edit (FR-016).
   */
  notifyRevisionCreated(documentId: string, currentRevision: number): void {
    const conversations = this.storage.listAllConversations(documentId);
    for (const conversation of conversations) {
      if (conversation.status === 'closed') continue;
      if (conversation.contextRevision !== currentRevision - 1) continue;

      this.publish(documentId, {
        type: 'conversation_stale',
        sequence: null,
        documentId,
        conversationId: conversation.id,
        at: new Date().toISOString(),
        data: { contextRevision: conversation.contextRevision, currentRevision },
      });
    }
  }

  /**
   * The actual content mutation (splice + its `document_content_changed` publish) runs under this
   * document's `PrimaryMutex` lock, same as every other document-mutating path
   * (`EditService.apply()`, `acceptRemaining`, the `propose_document_edit` tool) — a manual edit
   * arriving while an accept or a Primary-designation switch is in flight for the same document
   * serializes against it instead of racing it. The splice itself is also wrapped in
   * `storage.transaction()` so the Automerge `document_change` write and the
   * `document_content_changed` event-log write commit atomically.
   */
  async applyChanges(
    baseRevision: number | undefined,
    changes: DocumentChangeSpec[] | undefined,
    title: string | undefined,
  ): Promise<ApplyChangesResult> {
    const doc = this.storage.getDocument();
    if (!doc) throw new DocumentNotFoundError('Document not found');

    if (title !== undefined) {
      this.renameTitle(title);
    }

    if (changes && changes.length > 0) {
      // A bare revision-number mismatch does not by itself prove the document's CONTENT has moved
      // on. Manual edits (this method) never bump `currentRevision` themselves — only
      // `RevisionService.createRevision` does, on: (a) `manual_debounce`'s periodic checkpoints of
      // whatever content already exists (scheduled below, at the end of this same `if` block),
      // which never themselves change content, or (b) an `agent_edit`/`restore`, which do. That
      // means several manual edits from this same client routinely accumulate under one unchanged
      // `currentRevision` before any debounce fires — comparing actual content between
      // `baseRevision` and now (e.g. via each revision's retained Automerge `heads`, as
      // `RevisionService.restore`/`export` do) would *always* differ across that gap and isn't the
      // right test here. What actually matters is whether every revision created between
      // `baseRevision` and `currentRevision` was a content-preserving `manual_debounce` checkpoint
      // (safe to apply `changes` to the live content as usual — e.g. this same client's own
      // earlier edit retrying after transient network failures, whose debounce fired mid-retry)
      // versus at least one being a real content-changing `agent_edit`/`restore` (a genuine
      // conflict: this tab's local text no longer matches the document's actual shape, so
      // `changes`' offsets can no longer be trusted — reject, see `DocumentOutOfSyncError`).
      if (baseRevision !== undefined && baseRevision !== doc.currentRevision) {
        let onlyDebounceCheckpointsSinceBaseRevision = baseRevision < doc.currentRevision;
        for (let revision = baseRevision + 1; revision <= doc.currentRevision; revision += 1) {
          const row = this.storage.getRevision(doc.id, revision);
          if (!row || row.origin !== 'manual_debounce') {
            onlyDebounceCheckpointsSinceBaseRevision = false;
            break;
          }
        }

        if (!onlyDebounceCheckpointsSinceBaseRevision) {
          throw new DocumentOutOfSyncError(
            `Document has changed since baseRevision ${baseRevision} (current revision is ` +
              `${doc.currentRevision}); refetch the document via GET /api/document and retry your edit.`,
            doc.currentRevision,
          );
        }
        // Every intervening revision was a content-preserving debounce checkpoint — fall through
        // and apply `changes` to the live content as if `baseRevision` had matched.
      }

      // Descending offset order keeps earlier offsets valid as each splice is applied.
      const ordered = [...changes].sort((a, b) => b.from - a.from);

      await this.primaryMutex.withLock(doc.id, () => {
        this.storage.transaction(() => {
          this.automerge.get().splice(ordered);

          const content = this.automerge.get().getContent();
          const contentHash = createHash('sha256').update(content).digest('hex');

          this.publish(doc.id, {
            type: 'document_content_changed',
            sequence: null,
            documentId: doc.id,
            conversationId: null,
            at: new Date().toISOString(),
            data: {
              changes,
              currentRevision: doc.currentRevision,
              originConversationId: null,
              contentHash,
            },
          });
        });
      });

      this.revisionService.scheduleDebounce(doc.id);
    }

    return { currentRevision: doc.currentRevision, revisionCreated: false };
  }

  private publish(documentId: string, frame: ApplicationEvent): void {
    this.publisher.publishFrame(frame);
  }
}
