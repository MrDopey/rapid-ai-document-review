import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import type { ConflictDetail, RevisionRow, StorageAdapter } from '../storage/storage-adapter.ts';
import { reconcile } from './text-anchor.ts';
import type { AutomergeStoreHolder } from './automerge-store-holder.ts';
import type { DocumentService } from './document-service.ts';

export interface CreateRevisionOptions {
  source: RevisionRow['source'];
  origin: RevisionRow['origin'];
  conversationId?: string | null;
  stagedEditId?: string | null;
  restoredFrom?: number | null;
  note?: string | null;
  autoApplied?: boolean;
}

export interface PendingProposalReconciliationEntry {
  stagedEditId: string;
  reconcilable: boolean;
  conflictDetail?: ConflictDetail;
}

export interface RestoreResult {
  currentRevision: number;
  restoredFrom: number;
  content: string;
  /** Dry-run reconciliation of every `pending` staged_edit against the would-be-restored content
   *  (http-api.md §POST /revisions/:revision/restore), computed *before* the restore is committed.
   *  Read-only: never applies, supersedes, or otherwise changes any staged_edit's status — the
   *  user decides per-proposal afterwards. Omitted when there are no pending proposals. */
  pendingProposalReconciliation?: PendingProposalReconciliationEntry[];
}

/**
 * Logical revisions — a named milestone layered above the Automerge operation log
 * (Constitution Principle IV, data-model.md §2). Owns the manual-edit debounce timer,
 * revision creation, restore, and export.
 */
export class RevisionService {
  private debounceTimer: NodeJS.Timeout | null = null;
  /** Late-bound (server.ts, right after `DocumentService` is constructed): `DocumentService`
   *  already depends on `RevisionService` to create revisions, so `RevisionService` depending on
   *  `DocumentService` too would be a genuine construction cycle — broken the same way
   *  `PiService.setEditService` breaks its own cycle with `EditService` (pi-service.ts). Only used
   *  to notify, after every revision, which conversations just became stale (FR-016). */
  private documentService: DocumentService | null = null;

  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly automerge: AutomergeStoreHolder;

  constructor(storage: StorageAdapter, eventService: EventService, eventHub: EventHub, automerge: AutomergeStoreHolder) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.automerge = automerge;
  }

  setDocumentService(documentService: DocumentService): void {
    this.documentService = documentService;
  }

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

    this.documentService?.notifyRevisionCreated(documentId, row.revision);

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

    // Dry-run reconciliation (T072a, http-api.md §POST /revisions/:revision/restore): computed
    // against the would-be-restored content *before* anything below commits, and never mutates a
    // staged_edit's status — a pure read used only to populate the response.
    const pending = this.storage.listPendingStagedEdits(documentId);
    const pendingProposalReconciliation: PendingProposalReconciliationEntry[] | undefined =
      pending.length === 0
        ? undefined
        : pending.map((edit) => {
            const result = reconcile(edit.operations, restoredContent);
            return result.outcome === 'clean'
              ? { stagedEditId: edit.id, reconcilable: true }
              : { stagedEditId: edit.id, reconcilable: false, conflictDetail: result.detail };
          });

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

    return {
      currentRevision: revisionRow.revision,
      restoredFrom: revisionNumber,
      content: restoredContent,
      pendingProposalReconciliation,
    };
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
