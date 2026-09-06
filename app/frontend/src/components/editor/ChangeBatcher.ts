/**
 * Pure, host-agnostic change-batching logic (no CodeMirror or Vue import here) so the
 * debounce/flush behavior itself can be unit-tested without mounting a full CodeMirror view.
 *
 * `T` is left generic (rather than importing `ChangeSet` from `@codemirror/state`) so this file has
 * zero dependency on the editor library — EditorComponent.vue instantiates `ChangeBatcher<ChangeSet>`
 * and supplies the one CodeMirror-specific operation (`compose`) as a plain callback.
 */
export interface ChangeBatcherOptions<T> {
  /**
   * Combine a newly observed change into the running accumulated batch. Called with
   * `accumulated === null` for the first change since the last flush (nothing to compose onto
   * yet).
   */
  compose: (accumulated: T | null, change: T) => T;
  /**
   * Debounce delay (ms). A flush is scheduled this many ms after the *last* observed change, and
   * each new change pushes it back out again — this is what lets a burst of rapid edits collapse
   * into a single flush instead of one per keystroke.
   */
  debounceMs: number;
  /**
   * Optional hard cap (ms) on how long a batch may keep growing before it is forced to flush,
   * measured from the *first* unflushed change in the batch — independent of the debounce timer,
   * which a continuous run of edits (each arriving less than `debounceMs` apart) would otherwise
   * keep pushing out indefinitely. Without this, a sustained typing/paste burst never pauses long
   * enough to hit the debounce window, so the batch — and the cost of composing each new change
   * onto it — keeps growing for as long as the burst lasts. Omit to keep pure debounce semantics
   * (no cap).
   */
  maxWaitMs?: number;
  /** Injectable scheduler, mainly so tests can use a fake timer source without needing to touch
   *  the real global setTimeout/clearTimeout. Defaults to the real timer functions. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ChangeBatcher<T> {
  private readonly onFlush: (batch: T) => void;
  private readonly options: ChangeBatcherOptions<T>;
  private accumulated: T | null = null;
  private debounceHandle: unknown = null;
  private maxWaitHandle: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(onFlush: (batch: T) => void, options: ChangeBatcherOptions<T>) {
    this.onFlush = onFlush;
    this.options = options;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Accumulate one change and (re)schedule the debounced flush. */
  add(change: T): void {
    const startingNewBatch = this.accumulated === null;
    this.accumulated = this.options.compose(this.accumulated, change);

    if (startingNewBatch && this.options.maxWaitMs !== undefined) {
      this.maxWaitHandle = this.setTimer(() => this.flush(), this.options.maxWaitMs);
    }
    this.rescheduleDebounce();
  }

  private rescheduleDebounce(): void {
    if (this.debounceHandle !== null) this.clearTimer(this.debounceHandle);
    this.debounceHandle = this.setTimer(() => this.flush(), this.options.debounceMs);
  }

  /** Flush the accumulated batch (if any) to `onFlush` now, cancelling any pending timers. Safe to
   *  call when nothing is accumulated (a no-op). */
  flush(): void {
    this.clearTimers();
    if (this.accumulated === null) return;
    const batch = this.accumulated;
    this.accumulated = null;
    this.onFlush(batch);
  }

  /** Cancel any pending timers without flushing — call on unmount/teardown. */
  dispose(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.debounceHandle !== null) {
      this.clearTimer(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.maxWaitHandle !== null) {
      this.clearTimer(this.maxWaitHandle);
      this.maxWaitHandle = null;
    }
  }
}
