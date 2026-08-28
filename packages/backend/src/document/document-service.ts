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
import { toConversationDto } from '../conversation/conversation-mapper.ts';
import type { PrimaryMutex } from '../pi/primary-mutex.ts';
import { AutomergeStore } from './automerge-store.ts';
import type { AutomergeStoreHolder } from './automerge-store-holder.ts';
import type { RevisionService } from './revision-service.ts';

const OUT_OF_SYNC_REVISION_THRESHOLD = 50;

export interface DocumentChangeSpec {
  from: number;
  to: number;
  insert: string;
}

export class DocumentAlreadyExistsError extends Error {}
export class DocumentNotFoundError extends Error {}

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
      contextRevision: revisionRow.revision,
      branchDepth: 0,
      seedSelection: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    });

    return {
      document: toDocumentDto({ ...documentRow, currentRevision: revisionRow.revision }),
      content,
      mainConversation: toConversationDto(this.storage, mainConversationRow, revisionRow.revision),
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
   * FIX 4: the actual content mutation (splice + its `document_content_changed` publish) runs
   * under this document's `PrimaryMutex` lock, same as every other document-mutating path
   * (`EditService.apply()`, `acceptRemaining`, the `propose_document_edit` tool) — a manual edit
   * arriving while an accept or a Primary-designation switch is in flight for the same document
   * now serializes against it instead of racing it. The splice itself is also wrapped in
   * `storage.transaction()` (FIX 3) so the Automerge `document_change` write and the
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
      if (baseRevision !== undefined && doc.currentRevision - baseRevision > OUT_OF_SYNC_REVISION_THRESHOLD) {
        // No `event` field: this is a diagnostic about the client's request, not one of the
        // closed vocabulary's own domain events (FR-042).
        logger.warn(
          { documentId: doc.id, baseRevision, currentRevision: doc.currentRevision },
          'client applying changes from a badly out-of-sync base revision',
        );
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
    const persisted = this.eventService.append(
      documentId,
      frame.conversationId,
      frame.type,
      frame.data,
    );
    this.eventHub.broadcast(documentId, { ...frame, sequence: persisted.sequence, at: persisted.createdAt });
  }
}
