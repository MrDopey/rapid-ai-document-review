/**
 * The subset of the real Pi SDK's `AgentSession` surface that `PiService` depends on.
 * `FakeAgentSession` (pi/fake-agent-session.ts) implements this shape directly, so integration
 * tests (which all run under `RADR_BE_PI_FAKE_SESSIONS=1`) can drive deterministic agent behaviour
 * without a live model.
 *
 * The real `AgentSession` (from `@earendil-works/pi-coding-agent`) does NOT satisfy this
 * structurally — its `message_start`/`message_update`/`message_end` events carry a nested
 * `message`/`assistantMessageEvent` (content as text/thinking/toolCall blocks, no flat `id`),
 * not these flat fields. `PiService.getOrCreateSession` casts the real session to
 * `AgentSessionLike` anyway (`as unknown as`) purely so TypeScript accepts a single type through
 * `PiService`/`EventBridge`; `EventBridge.normalizeRealEvent` is what actually adapts each real
 * event down to this flat shape at runtime before anything here sees it.
 */

export interface PiAgentStartEvent {
  type: 'agent_start';
}

export interface PiMessageStartEvent {
  type: 'message_start';
  messageId: string;
  role: 'user' | 'assistant';
}

export interface PiTextDeltaEvent {
  type: 'message_update';
  messageId: string;
  update: { type: 'text_delta'; delta: string };
}

export interface PiThinkingDeltaEvent {
  type: 'message_update';
  messageId: string;
  update: { type: 'thinking_delta'; delta: string };
}

export interface PiMessageEndEvent {
  type: 'message_end';
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
}

export interface PiToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args?: unknown;
}

export interface PiToolExecutionUpdateEvent {
  type: 'tool_execution_update';
  toolCallId: string;
  delta: string;
}

export interface PiToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result?: unknown;
}

export interface PiAgentEndEvent {
  type: 'agent_end';
  willRetry: boolean;
}

export interface PiAgentSettledEvent {
  type: 'agent_settled';
}

export interface PiCompactionEvent {
  type: 'compaction_start' | 'compaction_end';
}

export interface PiQueueUpdateEvent {
  type: 'queue_update';
}

export interface PiAgentErrorEvent {
  type: 'agent_error';
  message: string;
}

export type AgentSessionEventLike =
  | PiAgentStartEvent
  | PiMessageStartEvent
  | PiTextDeltaEvent
  | PiThinkingDeltaEvent
  | PiMessageEndEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent
  | PiAgentEndEvent
  | PiAgentSettledEvent
  | PiCompactionEvent
  | PiQueueUpdateEvent
  | PiAgentErrorEvent;

export type AgentSessionEventListenerLike = (event: AgentSessionEventLike) => void;

export interface CustomMessageLike {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}

export interface AgentSessionLike {
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;

  subscribe(listener: AgentSessionEventListenerLike): () => void;
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  /** Injects a message into this session without necessarily triggering a new turn (research
   * R1: `session.sendCustomMessage({ ... }, { deliverAs: 'nextTurn' })`) — the mechanism behind
   * FR-034's parent-summary fold. `deliverAs: 'nextTurn'` appends the message for the session's
   * next turn to pick up as context, without starting one itself. */
  sendCustomMessage(
    message: CustomMessageLike,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): Promise<void>;
  getActiveToolNames(): string[];
  waitForIdle(): Promise<void>;
  dispose(): void;
  /** The real SDK's whole-tree export primitive (011-linear-thread-mode, User Story 4/FR-013b,
   * research.md R10): renders `SessionManager.getEntries()` — every branch in this session's
   * underlying file, not just the current path — as one self-contained, interactive HTML file,
   * writes it to `outputPath` (or a default location), and resolves its path. Optional: unlike
   * every other member here, `FakeAgentSession` (test-mode only, never used in production) does not
   * implement this — there is no live model/tool-rendering machinery to fake meaningfully for an
   * HTML exporter the way `prompt()`/`sendCustomMessage()` are faked for turn execution. */
  exportToHtml?(outputPath?: string): Promise<string>;
}
