import type { AutomergeStore } from './automerge-store.ts';

/** Shared registry so DocumentService and RevisionService can both reach any document's Automerge
 *  store, keyed by document id. */
export class AutomergeStoreHolder {
  private stores = new Map<string, AutomergeStore>();

  get(documentId: string): AutomergeStore {
    const store = this.stores.get(documentId);
    if (!store) {
      throw new Error('Document not created yet');
    }
    return store;
  }

  isSet(documentId: string): boolean {
    return this.stores.has(documentId);
  }

  set(documentId: string, store: AutomergeStore): void {
    this.stores.set(documentId, store);
  }

  delete(documentId: string): void {
    this.stores.delete(documentId);
  }
}
