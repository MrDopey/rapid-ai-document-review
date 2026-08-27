import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { EventHub } from '../events/event-hub.js';
import type { EventService } from '../events/event-service.js';
import type { RevisionRow, StorageAdapter } from '../storage/storage-adapter.js';
import type { AutomergeStoreHolder } from './automerge-store-holder.js';

export interface CreateRevisionOptions {
  source: RevisionRow['source'];
  origin: RevisionRow['origin'];
  conversationId?: string | null;
  stagedEditId?: string | null;
  restoredFrom?: number | null;
  note?: string | null;
  autoApplied?: boolean;
}

export interface RestoreResult {
  currentRevision: number;
  restoredFrom: number;
  content: string;
}

/**
 * Logical revisions — a named milestone layered above the Automerge operation log
 * (Constitution Principle IV, data-model.md §2). Owns the manual-edit debounce timer,
 * revision creation, restore, and export.
 */
export class RevisionService {
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly eventService: EventService,
    private readonly eventHub: EventHub,
    private readonly automerge: AutomergeStoreHolder,
  ) {}

  /** Resets the per-document debounce timer; fires a manual_debounce revision after inactivity. */
  scheduleDebounce(documentId: string): void {
    const debounceMs = this.storage.getSettings().revisionDebounceMs;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.createRevision(documentId, { source: 'user', origin: 'manual_debounce' });
    }, debounceMs);
    this.debounceTimer.unref?.();
  }

  cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  createRevision(documentId: string, options: CreateRevisionOptions): RevisionRow {
    const document = this.storage.getDocument();
    if (!document) throw new Error('Document not found');

    const store = this.automerge.get();
    const revisionNumber = document.currentRevision + 1;
    const heads = JSON.stringify(store.getHeads());
    const createdAt = new Date().toISOString();

    const row = this.storage.createRevision({
      documentId,
      revision: revisionNumber,
      source: options.source,
      origin: options.origin,
      conversationId: options.conversationId ?? null,
      stagedEditId: options.stagedEditId ?? null,
      restoredFrom: options.restoredFrom ?? null,
      note: options.note ?? null,
      autoApplied: options.autoApplied ?? false,
      heads,
      createdAt,
    });

    this.storage.updateDocumentRevision(documentId, revisionNumber, createdAt);
    if (store.shouldSnapshot()) {
      store.snapshot(revisionNumber);
    }

    this.publish(documentId, {
      type: 'revision_created',
      sequence: null,
      documentId,
      conversationId: row.conversationId,
      at: createdAt,
      data: {
        revision: row.revision,
        source: row.source,
        origin: row.origin,
        conversationId: row.conversationId,
        note: row.note,
        restoredFrom: row.restoredFrom,
      },
    });

    return row;
  }

  restore(documentId: string, revisionNumber: number): RestoreResult {
    const target = this.storage.getRevision(documentId, revisionNumber);
    if (!target) {
      throw new Error(`Revision not found: ${revisionNumber}`);
    }
    const store = this.automerge.get();
    const heads = JSON.parse(target.heads) as string[];
    const restoredContent = store.view(heads);
    store.updateText(restoredContent);

    const revisionRow = this.createRevision(documentId, {
      source: 'user',
      origin: 'restore',
      restoredFrom: revisionNumber,
      note: `Restored v${revisionNumber}`,
    });

    this.publish(documentId, {
      type: 'revision_restored',
      sequence: null,
      documentId,
      conversationId: null,
      at: revisionRow.createdAt,
      data: { revision: revisionRow.revision, restoredFrom: revisionNumber, content: restoredContent },
    });

    return { currentRevision: revisionRow.revision, restoredFrom: revisionNumber, content: restoredContent };
  }

  export(documentId: string, revisionNumber?: number): string | null {
    const store = this.automerge.get();
    if (revisionNumber === undefined) {
      return store.getContent();
    }
    const row = this.storage.getRevision(documentId, revisionNumber);
    if (!row) return null;
    return store.view(JSON.parse(row.heads) as string[]);
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
