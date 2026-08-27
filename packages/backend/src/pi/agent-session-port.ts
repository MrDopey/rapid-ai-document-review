/**
 * The subset of the real Pi SDK's `AgentSession` surface that `PiService` depends on.
 * `AgentSession` (from `@earendil-works/pi-coding-agent`) satisfies this structurally — nothing
 * here re-declares its implementation. `FakePiSession` (tests/fakes/) implements the same shape
 * so integration tests can drive deterministic agent behaviour without a live model.
 *
 * Event shapes mirror the subset of `AgentSessionEvent` the event-bridge contract
 * (contracts/agent-tools.md §Event bridge contract) depends on.
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

export interface AgentSessionLike {
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;

  subscribe(listener: AgentSessionEventListenerLike): () => void;
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  getActiveToolNames(): string[];
  waitForIdle(): Promise<void>;
  dispose(): void;
}
