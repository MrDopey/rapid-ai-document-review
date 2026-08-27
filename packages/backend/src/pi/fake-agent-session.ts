import { randomUUID } from 'node:crypto';
import type { AgentSessionEventLike, AgentSessionEventListenerLike, AgentSessionLike } from './agent-session-port.js';

function chunk(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A deterministic, credential-free stand-in for a real Pi `AgentSession`, used only when
 * `PI_FAKE_SESSIONS=1` (config.ts). Exists so `npm run test:e2e -- --grep "US2"` can exercise the
 * real send → ConcurrencyLimiter → PiService → EventBridge → EventHub → WS → UI path end to end
 * without a live model provider credential (quickstart.md: agent scenarios otherwise fail with
 * `AGENT_UNAVAILABLE` in an environment with no credential). Distinct from `tests/fakes/
 * fake-pi-session.ts`, which is manually scripted per-test and lives outside the compiled
 * backend; this one runs unattended inside the server process and always "answers".
 */
export class FakeAgentSession implements AgentSessionLike {
  readonly sessionId = randomUUID();
  sessionFile: string | undefined;

  private streaming = false;
  private readonly listeners = new Set<AgentSessionEventListenerLike>();

  constructor(sessionFile?: string) {
    this.sessionFile = sessionFile;
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
    return ['read_document'];
  }

  async waitForIdle(): Promise<void> {
    while (this.streaming) {
      await sleep(0);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }

  async prompt(text: string): Promise<void> {
    if (this.streaming) {
      throw new Error('FakeAgentSession: already streaming');
    }
    this.streaming = true;
    this.emit({ type: 'agent_start' });
    void this.runScript(text);
  }

  private emit(event: AgentSessionEventLike): void {
    for (const listener of this.listeners) listener(event);
  }

  private async runScript(userText: string): Promise<void> {
    const messageId = `fake_msg_${randomUUID()}`;
    this.emit({ type: 'message_start', messageId, role: 'assistant' });

    const reasoning = 'Considering the document and the question before answering.';
    for (const delta of chunk(reasoning, 10)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'thinking_delta', delta } });
      await sleep(5);
    }

    const text = `Here is a fake deterministic answer to: "${userText}".`;
    for (const delta of chunk(text, 6)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta } });
      await sleep(5);
    }

    this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning });
    this.streaming = false;
    this.emit({ type: 'agent_end', willRetry: false });
    this.emit({ type: 'agent_settled' });
  }
}
