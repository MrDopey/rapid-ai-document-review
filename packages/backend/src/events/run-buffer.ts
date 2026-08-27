/**
 * Per-active-run in-memory buffer for partial streamed text (FR-037a). A client reconnecting
 * mid-run replays this buffer before any subsequent delta, so it is never left blank until
 * `message_completed`. In-memory only — does not survive a restart (that is the FR-039a case,
 * where in-flight runs are marked errored rather than resumed).
 */
export class RunBuffer {
  private readonly buffers = new Map<string, string>();

  append(runId: string, delta: string): void {
    this.buffers.set(runId, (this.buffers.get(runId) ?? '') + delta);
  }

  getBuffer(runId: string): string {
    return this.buffers.get(runId) ?? '';
  }

  clear(runId: string): void {
    this.buffers.delete(runId);
  }
}
