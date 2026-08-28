import * as Automerge from '@automerge/automerge';
import type { StorageAdapter } from '../storage/storage-adapter.ts';

interface DocShape {
  content: string;
}

const SNAPSHOT_EVERY_N_CHANGES = 20;

/**
 * Owns the Automerge CRDT lifecycle for one document: load (snapshot + incremental changes),
 * incremental save, periodic snapshotting, and materialising past revisions via `view(heads)`.
 * This is the only module that touches the Automerge API directly outside text-anchor.ts.
 */
export class AutomergeStore {
  private doc: Automerge.Doc<DocShape>;
  private changesSinceSnapshot = 0;
  private lastSavedHeads: Automerge.Heads;
  private readonly storage: StorageAdapter;
  private readonly documentId: string;

  private constructor(storage: StorageAdapter, documentId: string, doc: Automerge.Doc<DocShape>) {
    this.storage = storage;
    this.documentId = documentId;
    this.doc = doc;
    this.lastSavedHeads = Automerge.getHeads(doc);
  }

  static create(storage: StorageAdapter, documentId: string, initialContent: string): AutomergeStore {
    const doc = Automerge.change(Automerge.init<DocShape>(), (d) => {
      d.content = initialContent;
    });
    const store = new AutomergeStore(storage, documentId, doc);
    store.snapshot(1);
    return store;
  }

  static load(storage: StorageAdapter, documentId: string): AutomergeStore {
    const snapshot = storage.getLatestSnapshot(documentId);
    let doc = snapshot
      ? Automerge.load<DocShape>(snapshot.data)
      : Automerge.init<DocShape>();
    const afterId = 0; // document_change rows are pruned only when a snapshot provably covers them
    const changes = storage.listChangesSince(documentId, afterId);
    for (const change of changes) {
      doc = Automerge.loadIncremental(doc, change.data);
    }
    return new AutomergeStore(storage, documentId, doc);
  }

  getContent(): string {
    return this.doc.content;
  }

  getHeads(): Automerge.Heads {
    return Automerge.getHeads(this.doc);
  }

  view(heads: Automerge.Heads): string {
    const viewed = Automerge.view(this.doc, heads);
    return viewed.content;
  }

  /** Applies one or more offset-ordered splices as a single Automerge change and persists it. */
  splice(operations: { from: number; to: number; insert: string }[]): void {
    this.doc = Automerge.change(this.doc, (d) => {
      for (const op of operations) {
        const delLen = op.to - op.from;
        Automerge.splice(d, ['content'], op.from, delLen, op.insert);
      }
    });
    this.persistIncremental();
  }

  /** Replaces the full text with `newContent`, expressed as a diff against current (restore only). */
  updateText(newContent: string): void {
    this.doc = Automerge.change(this.doc, (d) => {
      Automerge.updateText(d, ['content'], newContent);
    });
    this.persistIncremental();
  }

  private persistIncremental(): void {
    const change = Automerge.getLastLocalChange(this.doc);
    if (!change) return;
    this.storage.appendChange({
      documentId: this.documentId,
      data: change,
      createdAt: new Date().toISOString(),
    });
    this.lastSavedHeads = Automerge.getHeads(this.doc);
    this.changesSinceSnapshot += 1;
  }

  /** Call after tagging a logical revision, when RevisionService decides a snapshot is due. */
  snapshot(revision: number): void {
    const data = Automerge.save(this.doc);
    this.storage.createSnapshot({
      documentId: this.documentId,
      revision,
      data,
      createdAt: new Date().toISOString(),
    });
    this.changesSinceSnapshot = 0;
  }

  shouldSnapshot(): boolean {
    return this.changesSinceSnapshot >= SNAPSHOT_EVERY_N_CHANGES;
  }
}
