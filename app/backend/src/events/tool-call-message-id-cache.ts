/**
 * Tiny in-memory sibling of `RunBuffer` (see that file's own doc comment): carries the message id
 * a tool call was requested from from the moment `EventBridge` observes `tool_execution_start`
 * to the few milliseconds later when that tool's own `execute()` reads it — a SQLite round trip
 * for something this short-lived is unnecessary. In-memory only, does not survive a restart.
 */
export class ToolCallMessageIdCache {
  private readonly ids = new Map<string, string>();

  set(toolCallId: string, messageId: string): void {
    this.ids.set(toolCallId, messageId);
  }

  /** Read once, then forget — nothing lingers past its one intended read. */
  take(toolCallId: string): string | null {
    const id = this.ids.get(toolCallId) ?? null;
    this.ids.delete(toolCallId);
    return id;
  }
}
