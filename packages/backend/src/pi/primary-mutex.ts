/**
 * A minimal per-document async mutex. `propose_document_edit` holds it for the duration of one
 * `execute` call (http-api.md §POST /primary "Primary switch and tool execution are mutually
 * exclusive") so a future `PrimaryService` (US5) designation change can wait for any in-flight
 * proposal to finish before flipping `is_primary`, and a proposal that starts captures the
 * designation for its whole call. US5 is not implemented yet — nothing else contends for this
 * lock today — but the seam is here so designate()/switch logic can plug into the same lock
 * without a rewrite.
 */
export class PrimaryMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(documentId: string, fn: () => Promise<T> | T): Promise<T> {
    const tail = this.tails.get(documentId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(documentId, tail.then(() => next));
    await tail;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
