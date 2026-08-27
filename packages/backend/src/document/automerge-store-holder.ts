import type { AutomergeStore } from './automerge-store.js';

/** Shared mutable slot so DocumentService and RevisionService can both reach the one Automerge store. */
export class AutomergeStoreHolder {
  private store: AutomergeStore | null = null;

  get(): AutomergeStore {
    if (!this.store) {
      throw new Error('Document not created yet');
    }
    return this.store;
  }

  isSet(): boolean {
    return this.store !== null;
  }

  set(store: AutomergeStore): void {
    this.store = store;
  }
}
