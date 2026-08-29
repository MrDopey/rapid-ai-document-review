import { randomUUID } from 'node:crypto';
import type {
  AgentSessionEventLike,
  AgentSessionEventListenerLike,
  AgentSessionLike,
} from '../../src/pi/agent-session-port.js';

/**
 * Deterministic double for the Pi SDK's `AgentSession`, used by integration/contract tests to
 * drive FR-032 (conflict/replacement), FR-037 (disconnect survives), FR-040 (idempotent tool
 * calls) and similar scenarios without a live model. Tests script exactly which events fire and
 * when — nothing here auto-generates plausible-looking agent behaviour.
 */
export class FakePiSession implements AgentSessionLike {
  readonly sessionId: string;
  sessionFile: string | undefined;

  private streaming = false;
  private disposed = false;
  private readonly listeners = new Set<AgentSessionEventListenerLike>();
  private nextPromptShouldReject: Error | null = null;
  readonly prompts: string[] = [];

  constructor(options: { sessionId?: string; sessionFile?: string } = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.sessionFile = options.sessionFile;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get isIdle(): boolean {
    return !this.streaming;
  }

  subscribe(listener: AgentSessionEventListenerLike): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getActiveToolNames(): string[] {
    return [...this.activeToolNames];
  }

  private activeToolNames: string[] = ['read_document', 'propose_document_edit'];

  setActiveToolNames(names: string[]): void {
    this.activeToolNames = names;
  }

  async waitForIdle(): Promise<void> {
    while (this.streaming) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Test setup: make the next `prompt()` call reject, simulating an immediate model/agent failure. */
  failNextPrompt(error: Error): void {
    this.nextPromptShouldReject = error;
  }

  async prompt(
    text: string,
    options?: { streamingBehavior?: 'steer' | 'followUp' },
  ): Promise<void> {
    if (this.streaming && !options?.streamingBehavior) {
      throw new Error('FakePiSession: already streaming; pass streamingBehavior to queue');
    }
    if (this.nextPromptShouldReject) {
      const error = this.nextPromptShouldReject;
      this.nextPromptShouldReject = null;
      throw error;
    }
    this.prompts.push(text);
    this.streaming = true;
    this.emit({ type: 'agent_start' });
  }

  // ---- Scripted event emission ----

  emit(event: AgentSessionEventLike): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  emitMessageStart(messageId: string, role: 'user' | 'assistant' = 'assistant'): void {
    this.emit({ type: 'message_start', messageId, role });
  }

  emitTextDelta(messageId: string, delta: string): void {
    this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta } });
  }

  emitThinkingDelta(messageId: string, delta: string): void {
    this.emit({ type: 'message_update', messageId, update: { type: 'thinking_delta', delta } });
  }

  emitMessageCompleted(
    messageId: string,
    text: string,
    options: { reasoning?: string; role?: 'user' | 'assistant' } = {},
  ): void {
    this.emit({
      type: 'message_end',
      messageId,
      role: options.role ?? 'assistant',
      text,
      reasoning: options.reasoning,
    });
  }

  emitToolStarted(toolCallId: string, toolName: string): void {
    this.emit({ type: 'tool_execution_start', toolCallId, toolName });
  }

  emitToolOutputDelta(toolCallId: string, delta: string): void {
    this.emit({ type: 'tool_execution_update', toolCallId, delta });
  }

  emitToolCompleted(
    toolCallId: string,
    toolName: string,
    options: { isError?: boolean; result?: unknown } = {},
  ): void {
    this.emit({
      type: 'tool_execution_end',
      toolCallId,
      toolName,
      isError: options.isError ?? false,
      result: options.result,
    });
  }

  emitAgentError(message: string): void {
    this.streaming = false;
    this.emit({ type: 'agent_error', message });
  }

  /** Completes the current run: agent_end followed by agent_settled, and clears isStreaming. */
  completeRun(): void {
    this.streaming = false;
    this.emit({ type: 'agent_end', willRetry: false });
    this.emit({ type: 'agent_settled' });
  }
}
