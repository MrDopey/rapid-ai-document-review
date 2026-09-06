import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The per-document write lock: a minimal async mutex, one FIFO tail-chain per `documentId`. It is
 * the single lock EVERY document-mutating path serializes against: manual edits
 * (`DocumentService.applyChanges`), `EditService.apply()` (both the HTTP accept path and
 * `acceptRemaining`), the `propose_document_edit` tool path, and `PrimaryService`'s designation
 * switch/clear (held for the duration of one `execute` call — http-api.md §POST /primary "Primary
 * switch and tool execution are mutually exclusive") — all via the same `withLock` call — so none
 * of them can read-then-write document content while another is doing the same, and none of them
 * can run concurrently with a Primary-designation switch either.
 *
 * Reentrant per document within one async call chain: `AsyncLocalStorage` tracks which
 * `documentId`s the *current* chain already holds, so e.g. `propose_document_edit`
 * (document-tools.ts) acquiring the lock and then calling `EditService.stageAndApplyPrimary` →
 * `EditService.apply()` — which itself calls `withLock` again for the same document — runs inline
 * instead of deadlocking against its own outer lock. A genuinely separate call chain (a different
 * HTTP request, a different tool execution) never shares the outer chain's ALS store, so it still
 * queues normally behind whichever chain is currently holding the document's lock.
 */
export class PrimaryMutex {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly held = new AsyncLocalStorage<Set<string>>();

  async withLock<T>(documentId: string, fn: () => Promise<T> | T): Promise<T> {
    const current = this.held.getStore();
    if (current?.has(documentId)) {
      // Already held by this same async call chain — run inline rather than awaiting a tail this
      // chain itself would otherwise never release.
      return await fn();
    }

    const tail = this.tails.get(documentId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(documentId, tail.then(() => next));
    await tail;

    const nextHeld = new Set(current ?? []);
    nextHeld.add(documentId);
    try {
      return await this.held.run(nextHeld, () => fn());
    } finally {
      release();
    }
  }
}
