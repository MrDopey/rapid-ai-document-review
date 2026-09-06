/**
 * Per-active-run in-memory buffer for partial streamed text (FR-037a). A client reconnecting
 * mid-run replays this buffer before any subsequent delta, so it is never left blank until
 * `message_completed`. In-memory only — does not survive a restart (that is the FR-039a case,
 * where in-flight runs are marked errored rather than resumed).
 */
export class RunBuffer {
  // Chunks accumulate here and are joined only when `getBuffer` is actually called (on a
  // reconnect mid-run) — appending via `+` on every delta would be O(n^2) over a long streamed
  // response, since each append would re-copy the entire string built so far.
  private readonly buffers = new Map<string, string[]>();

  append(runId: string, delta: string): void {
    let chunks = this.buffers.get(runId);
    if (!chunks) {
      chunks = [];
      this.buffers.set(runId, chunks);
    }
    chunks.push(delta);
  }

  getBuffer(runId: string): string {
    return (this.buffers.get(runId) ?? []).join('');
  }

  clear(runId: string): void {
    this.buffers.delete(runId);
  }
}
