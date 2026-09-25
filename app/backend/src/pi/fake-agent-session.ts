import { randomUUID } from 'node:crypto';
import type {
  AgentSessionEventLike,
  AgentSessionEventListenerLike,
  AgentSessionLike,
  CustomMessageLike,
} from './agent-session-port.ts';
import type { RegisteredToolLike } from './pi-service.ts';

function chunk(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test-only scripting protocol for driving `propose_document_edit` deterministically through
 * `FakeAgentSession` (no real model ever decides to call a tool here). A user/system message
 * beginning with this prefix, followed by a JSON `{ summary, operations }` payload matching
 * `proposeDocumentEditParams`, causes the fake session to actually invoke the real
 * `propose_document_edit` tool object it was constructed with — exercising the genuine
 * EditService/ConflictService pipeline end to end, not a stubbed response.
 */
export const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';

function parseDirective(
  text: string,
): { summary: string; operations: { old_string: string; new_string: string }[] } | null {
  if (!text.startsWith(PROPOSE_EDIT_DIRECTIVE)) return null;
  try {
    return JSON.parse(text.slice(PROPOSE_EDIT_DIRECTIVE.length));
  } catch {
    return null;
  }
}

/**
 * Same protocol as `PROPOSE_EDIT_DIRECTIVE`, for `read_document` (US4 staleness/refresh
 * scenarios): a message beginning with this prefix, optionally followed by a JSON
 * `{ from_line?, to_line? }` payload, causes the fake session to actually invoke the real
 * `read_document` tool and echo its full text result back as the assistant's answer. That result
 * embeds `conversation.context_revision` and the document content served at it (document-
 * tools.ts's `renderReadResult`), which is what lets a test assert exactly what content/revision
 * the agent "saw" without any real model in the loop.
 */
export const READ_DOCUMENT_DIRECTIVE = '__READ_DOCUMENT__';

function parseReadDirective(text: string): { from_line?: number; to_line?: number } | null {
  if (!text.startsWith(READ_DOCUMENT_DIRECTIVE)) return null;
  const rest = text.slice(READ_DOCUMENT_DIRECTIVE.length);
  if (!rest) return {};
  try {
    return JSON.parse(rest);
  } catch {
    return {};
  }
}

/**
 * Same protocol as `READ_DOCUMENT_DIRECTIVE`, for `web_search` — lets a test exercise a
 * `tool_started`/`tool_completed` pair carrying `args`/`resultText` without a real model or a live
 * SearXNG instance in the loop. A message beginning with this prefix, followed by a JSON
 * `{ query }` payload, invokes the real `web_search` tool object.
 */
export const WEB_SEARCH_DIRECTIVE = '__WEB_SEARCH__';

function parseWebSearchDirective(text: string): { query: string } | null {
  if (!text.startsWith(WEB_SEARCH_DIRECTIVE)) return null;
  try {
    return JSON.parse(text.slice(WEB_SEARCH_DIRECTIVE.length));
  } catch {
    return null;
  }
}

/**
 * A message beginning with this prefix causes the fake session to fail the turn deterministically
 * (`agent_error` instead of `agent_settled`) rather than answer — US5's FR-029a scenario needs a
 * conversation to become `errored` on cue, to prove a pending "switch when idle" designation is
 * silently cancelled rather than applied against a now-ineligible target. Optional JSON after the
 * prefix may supply a custom `message`; otherwise a default is used.
 */
export const ERROR_DIRECTIVE = '__AGENT_ERROR__';

function parseErrorDirective(text: string): { message?: string } | null {
  if (!text.startsWith(ERROR_DIRECTIVE)) return null;
  const rest = text.slice(ERROR_DIRECTIVE.length);
  if (!rest) return {};
  try {
    return JSON.parse(rest);
  } catch {
    return {};
  }
}

/**
 * Same protocol family as the directives above, generalized across all four Todo/Parking Lot list
 * tools (012-todo-parking-lists) instead of one directive per tool — a message beginning with this
 * prefix, followed by JSON `{ tool: 'list_items' | 'add_list_item' | 'update_list_item' |
 * 'remove_list_item', params }`, invokes that real tool object with `params` and echoes its text
 * result back as the assistant's answer.
 */
export const LIST_ITEM_TOOL_DIRECTIVE = '__CALL_LIST_ITEM_TOOL__';

const LIST_ITEM_TOOL_NAMES = [
  'list_items',
  'add_list_item',
  'update_list_item',
  'remove_list_item',
] as const;
type ListItemToolName = (typeof LIST_ITEM_TOOL_NAMES)[number];

function parseListItemToolDirective(
  text: string,
): { tool: ListItemToolName; params: Record<string, unknown> } | null {
  if (!text.startsWith(LIST_ITEM_TOOL_DIRECTIVE)) return null;
  try {
    const parsed = JSON.parse(text.slice(LIST_ITEM_TOOL_DIRECTIVE.length)) as {
      tool: string;
      params?: Record<string, unknown>;
    };
    if (!(LIST_ITEM_TOOL_NAMES as readonly string[]).includes(parsed.tool)) return null;
    return { tool: parsed.tool as ListItemToolName, params: parsed.params ?? {} };
  } catch {
    return null;
  }
}

/**
 * A message beginning with this prefix causes the fake session to simulate a stuck tool call/turn:
 * `runScript` never resolves on its own for it. Exercises the case where a hung tool call would
 * otherwise leave `streaming` stuck `true` forever — `prompt()` fires-and-forgets `runScript()`, so
 * without a bounded timeout, a hang there would permanently fail every subsequent send/retry on
 * that conversation with "already streaming". Only the bounded timeout in `runTurn` below can
 * settle a turn started with this directive — it always resolves as `agent_error`, never
 * `agent_settled`.
 */
export const HANG_DIRECTIVE = '__HANG__';

function isHangDirective(text: string): boolean {
  return text.startsWith(HANG_DIRECTIVE);
}

/** Default bound on how long one fake turn may run before it is force-settled as `agent_error`.
 *  Overridable via `RADR_BE_TEST_FAKE_TURN_TIMEOUT_MS` so tests exercising the hang path don't have to wait
 *  out a production-sized timeout.
 *
 *  Must stay comfortably above the slowest *legitimate* scripted turn any e2e spec drives through
 *  this session: a plain answer's wall-clock time scales with the echoed user text (`runPlainAnswer`
 *  chunks it 6 chars per `message_update`, 5ms apart), and us5.spec.ts's "act while active" step
 *  deliberately sends a ~6000-char message to stay streaming across two test steps — which alone
 *  takes ~5s to legitimately finish. This is a fixture-timing constant, not a correctness guard,
 *  since raising it does not weaken hang detection — a genuinely stuck turn (`HANG_DIRECTIVE`)
 *  still force-settles, just after a longer wait. */
const DEFAULT_TURN_TIMEOUT_MS = 30_000;

function resolveTurnTimeoutMs(): number {
  const override = Number(process.env.RADR_BE_TEST_FAKE_TURN_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_TURN_TIMEOUT_MS;
}

/** Per-chunk delay between streamed `message_update`/`thinking_delta` events (default 5ms,
 *  mirroring a real model's incremental output — see DEFAULT_TURN_TIMEOUT_MS's note on
 *  `us5.spec.ts`'s "act while active" step, which depends on this being nonzero real time).
 *  `RADR_BE_TEST_FAKE_CHUNK_DELAY_MS=0` (set by `tests/setup/env-defaults.ts` for vitest runs, which don't
 *  need to observe a streaming window) collapses every turn to settle within a tick, so contract
 *  tests' `waitFor` polling has nothing to wait out. */
function resolveChunkDelayMs(): number {
  const override = Number(process.env.RADR_BE_TEST_FAKE_CHUNK_DELAY_MS);
  return Number.isFinite(override) && override >= 0 ? override : 5;
}

/**
 * A deterministic, credential-free stand-in for a real Pi `AgentSession`, used only when
 * `RADR_BE_PI_FAKE_SESSIONS=1` (config.ts). Exists so `npm run test:e2e -- --grep "US2"` can exercise the
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
  private readonly tools: RegisteredToolLike[];
  /** Messages queued via `sendCustomMessage` (FR-034's fold-summary delivery, research R1) that
   * have not yet been picked up by a turn — mirrors real `deliverAs: 'nextTurn'` semantics
   * (appended for the *next* turn, no turn triggered here). Consumed and echoed back into the
   * very next plain answer so an e2e test can assert the delivered content deterministically,
   * without a real model in the loop. */
  private readonly pendingCustomMessages: string[] = [];
  /** Content delivered via `sendCustomMessage` with neither `deliverAs: 'nextTurn'` nor
   *  `triggerTurn` set (`PiService.seedSession` — a branch's auto-seed message) — mirrors the real
   *  SDK's non-streaming/no-trigger persistence branch (`agent-session.js`'s `sendCustomMessage`),
   *  which appends straight to `state.messages`/the on-disk session file rather than the transient
   *  `_pendingNextTurnMessages` queue `deliverAs: 'nextTurn'` uses. Kept permanently (never
   *  drained/consumed the way `pendingCustomMessages` is), since real session history is never
   *  discarded either — only exposed for tests via `getSeededHistory()`, to prove seed content
   *  reached this session's own context rather than only the app's event log. */
  private readonly seededHistory: string[] = [];
  private readonly turnTimeoutMs: number;
  private readonly chunkDelayMs: number;

  constructor(
    sessionFile?: string,
    tools: RegisteredToolLike[] = [],
    turnTimeoutMs?: number,
    chunkDelayMs?: number,
  ) {
    this.sessionFile = sessionFile;
    this.tools = tools;
    this.turnTimeoutMs = turnTimeoutMs ?? resolveTurnTimeoutMs();
    this.chunkDelayMs = chunkDelayMs ?? resolveChunkDelayMs();
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
    return this.tools.map((t) => t.name);
  }

  /** Test-mode stand-in for the real SDK's `sendCustomMessage` (research R1). Never triggers a
   * turn itself, either way — mirroring both real delivery modes this codebase actually uses:
   *  - `deliverAs: 'nextTurn'` (`deliverFoldSummary`): queues the content for the very next plain
   *    answer to echo back once, then discards it — matching the real SDK's transient
   *    `_pendingNextTurnMessages` queue.
   *  - no `deliverAs`/`triggerTurn` (`PiService.seedSession`, a branch's auto-seed message):
   *    appends permanently to `seededHistory` instead, mirroring the real SDK's immediate
   *    history-persist branch — never drained, since real session history isn't either. */
  async sendCustomMessage(
    message: CustomMessageLike,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): Promise<void> {
    if (options?.deliverAs === 'nextTurn') {
      this.pendingCustomMessages.push(message.content);
      return;
    }
    this.seededHistory.push(message.content);
  }

  /** Test-only accessor: everything ever delivered via `sendCustomMessage` without
   *  `deliverAs: 'nextTurn'` (i.e. `PiService.seedSession`'s branch-seed path) — proves the
   *  content reached this session's own persisted context, not merely the app's event log. */
  getSeededHistory(): string[] {
    return [...this.seededHistory];
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
    // Fire-and-forget, deliberately: real `AgentSession.prompt()` resolves once the turn is
    // *submitted*, not once it settles — the caller (PiService.send) learns the outcome later via
    // the subscribed event stream. `runTurn` (not `runScript` directly) is what guarantees this
    // never leaves `streaming` stuck `true` no matter how the turn ends.
    void this.runTurn(text);
  }

  private emit(event: AgentSessionEventLike): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Emits an empty-text/no-reasoning `message_start`/`message_end` pair immediately before a
   * scripted tool call, mirroring the real SDK's "tool-call-only carrier" message segment
   * (event-bridge.test.ts's "real-SDK tool-call-carrier message segments") — this is what gives
   * `EventBridge` a current message id to attribute the following `tool_execution_start`/`_end`
   * pair to. */
  private emitToolCallCarrier(): void {
    const messageId = `fake_msg_${randomUUID()}`;
    this.emit({ type: 'message_start', messageId, role: 'assistant' });
    this.emit({
      type: 'message_end',
      messageId,
      role: 'assistant',
      text: '',
      reasoning: undefined,
    });
  }

  /**
   * Runs one scripted turn to completion, guaranteeing `streaming` resets to `false` and exactly
   * one of `agent_settled`/`agent_error` fires — regardless of whether `runScript` resolves
   * normally, throws (e.g. `ERROR_DIRECTIVE`), or never resolves at all (`HANG_DIRECTIVE`, or any
   * unexpected real-world hang inside a scripted tool call). Without this guarantee, a bare
   * `void`-called `runScript()` with no `.catch` and no timeout would let a hang or unhandled throw
   * leave `streaming` permanently `true`, failing every later send/retry on the conversation
   * immediately with "already streaming", with no way to recover.
   */
  private async runTurn(userText: string): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timed_out'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timed_out'), this.turnTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      const outcome = await Promise.race([
        this.runScript(userText).then(() => 'done' as const),
        timedOut,
      ]);
      if (outcome === 'timed_out') {
        this.emit({
          type: 'agent_error',
          message: `Agent turn timed out after ${this.turnTimeoutMs}ms (stuck tool call or unresponsive script).`,
        });
        return;
      }
      this.emit({ type: 'agent_end', willRetry: false });
      this.emit({ type: 'agent_settled' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'agent_error', message });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.streaming = false;
    }
  }

  private async runScript(userText: string): Promise<void> {
    const errorDirective = parseErrorDirective(userText);
    if (errorDirective) {
      await sleep(this.chunkDelayMs);
      throw new Error(errorDirective.message ?? 'Simulated agent failure (test directive).');
    }

    if (isHangDirective(userText)) {
      // Simulates a stuck tool call: this deliberately never resolves — only `runTurn`'s own
      // timeout above can settle a turn started with it.
      await new Promise<void>(() => {});
      return;
    }

    const proposeDirective = parseDirective(userText);
    const readDirective = proposeDirective ? null : parseReadDirective(userText);
    const webSearchDirective =
      proposeDirective || readDirective ? null : parseWebSearchDirective(userText);
    const listItemDirective =
      proposeDirective || readDirective || webSearchDirective
        ? null
        : parseListItemToolDirective(userText);
    if (proposeDirective) {
      await this.runProposeEditDirective(proposeDirective);
    } else if (readDirective) {
      await this.runReadDocumentDirective(readDirective);
    } else if (webSearchDirective) {
      await this.runWebSearchDirective(webSearchDirective);
    } else if (listItemDirective) {
      await this.runListItemToolDirective(listItemDirective);
    } else {
      await this.runPlainAnswer(userText);
    }
  }

  private async runPlainAnswer(userText: string): Promise<string> {
    const messageId = `fake_msg_${randomUUID()}`;
    this.emit({ type: 'message_start', messageId, role: 'assistant' });

    const reasoning = 'Considering the document and the question before answering.';
    for (const delta of chunk(reasoning, 10)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'thinking_delta', delta } });
      await sleep(this.chunkDelayMs);
    }

    // Echo back any fold summaries delivered via `sendCustomMessage` since the last turn
    // (FR-034), so a test can assert the parent's next answer reflects the folded content.
    const noted =
      this.pendingCustomMessages.length > 0
        ? `\n\n[Noted custom context: ${this.pendingCustomMessages.join(' | ')}]`
        : '';
    this.pendingCustomMessages.length = 0;

    const text = `Here is a fake deterministic answer to: "${userText}".${noted}`;
    for (const delta of chunk(text, 6)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta } });
      await sleep(this.chunkDelayMs);
    }

    this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning });
    return text;
  }

  /** Actually invokes the real `propose_document_edit` tool object (document-tools.ts) — this is
   * what makes US3 e2e scenarios exercise the genuine EditService/ConflictService pipeline instead
   * of a canned response, deterministically, with no live model involved. */
  private async runProposeEditDirective(directive: {
    summary: string;
    operations: { old_string: string; new_string: string }[];
  }): Promise<string> {
    const toolCallId = `fake_tool_${randomUUID()}`;
    const tool = this.tools.find((t) => t.name === 'propose_document_edit');

    if (!tool) {
      const text = 'propose_document_edit is not available in this conversation.';
      const messageId = `fake_msg_${randomUUID()}`;
      this.emit({ type: 'message_start', messageId, role: 'assistant' });
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta: text } });
      this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
      return text;
    }

    this.emitToolCallCarrier();
    this.emit({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'propose_document_edit',
      args: directive,
    });
    const result = (await tool.execute(toolCallId, directive, undefined, undefined, undefined)) as {
      content?: { type: string; text?: string }[];
    };
    this.emit({
      type: 'tool_execution_end',
      toolCallId,
      toolName: 'propose_document_edit',
      isError: false,
      result,
    });

    const text = result.content?.[0]?.text ?? 'Done.';
    const messageId = `fake_msg_${randomUUID()}`;
    this.emit({ type: 'message_start', messageId, role: 'assistant' });
    for (const delta of chunk(text, 12)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta } });
      await sleep(this.chunkDelayMs);
    }
    this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
    return text;
  }

  /** Actually invokes the real `read_document` tool object (document-tools.ts) and echoes its
   * text result as the assistant's answer — see `READ_DOCUMENT_DIRECTIVE` above. */
  private async runReadDocumentDirective(params: {
    from_line?: number;
    to_line?: number;
  }): Promise<string> {
    const toolCallId = `fake_tool_${randomUUID()}`;
    const tool = this.tools.find((t) => t.name === 'read_document');

    if (!tool) {
      const text = 'read_document is not available in this conversation.';
      const messageId = `fake_msg_${randomUUID()}`;
      this.emit({ type: 'message_start', messageId, role: 'assistant' });
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta: text } });
      this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
      return text;
    }

    this.emitToolCallCarrier();
    this.emit({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'read_document',
      args: params,
    });
    const result = (await tool.execute(toolCallId, params, undefined, undefined, undefined)) as {
      content?: { type: string; text?: string }[];
    };
    this.emit({
      type: 'tool_execution_end',
      toolCallId,
      toolName: 'read_document',
      isError: false,
      result,
    });

    const text = result.content?.[0]?.text ?? 'No content.';
    const messageId = `fake_msg_${randomUUID()}`;
    this.emit({ type: 'message_start', messageId, role: 'assistant' });
    for (const delta of chunk(text, 12)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta } });
      await sleep(this.chunkDelayMs);
    }
    this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
    return text;
  }

  /** Actually invokes the real `web_search` tool object (tools/web-search.ts) and echoes its text
   * result as the assistant's answer — see `WEB_SEARCH_DIRECTIVE` above. */
  private async runWebSearchDirective(params: { query: string }): Promise<string> {
    const toolCallId = `fake_tool_${randomUUID()}`;
    const tool = this.tools.find((t) => t.name === 'web_search');

    if (!tool) {
      const text = 'web_search is not available in this conversation.';
      const messageId = `fake_msg_${randomUUID()}`;
      this.emit({ type: 'message_start', messageId, role: 'assistant' });
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta: text } });
      this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
      return text;
    }

    this.emitToolCallCarrier();
    this.emit({ type: 'tool_execution_start', toolCallId, toolName: 'web_search', args: params });
    const result = (await tool.execute(toolCallId, params, undefined, undefined, undefined)) as {
      content?: { type: string; text?: string }[];
    };
    this.emit({
      type: 'tool_execution_end',
      toolCallId,
      toolName: 'web_search',
      isError: false,
      result,
    });

    const text = result.content?.[0]?.text ?? 'No results.';
    const messageId = `fake_msg_${randomUUID()}`;
    this.emit({ type: 'message_start', messageId, role: 'assistant' });
    for (const delta of chunk(text, 12)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta } });
      await sleep(this.chunkDelayMs);
    }
    this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
    return text;
  }

  /** Actually invokes one of the four real Todo/Parking Lot list tool objects
   *  (tools/list-items.ts) and echoes its text result as the assistant's answer — see
   *  `LIST_ITEM_TOOL_DIRECTIVE` above. */
  private async runListItemToolDirective(directive: {
    tool: ListItemToolName;
    params: Record<string, unknown>;
  }): Promise<string> {
    const toolCallId = `fake_tool_${randomUUID()}`;
    const tool = this.tools.find((t) => t.name === directive.tool);

    if (!tool) {
      const text = `${directive.tool} is not available in this conversation.`;
      const messageId = `fake_msg_${randomUUID()}`;
      this.emit({ type: 'message_start', messageId, role: 'assistant' });
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta: text } });
      this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
      return text;
    }

    this.emitToolCallCarrier();
    this.emit({
      type: 'tool_execution_start',
      toolCallId,
      toolName: directive.tool,
      args: directive.params,
    });
    const result = (await tool.execute(
      toolCallId,
      directive.params,
      undefined,
      undefined,
      undefined,
    )) as {
      content?: { type: string; text?: string }[];
    };
    this.emit({
      type: 'tool_execution_end',
      toolCallId,
      toolName: directive.tool,
      isError: false,
      result,
    });

    const text = result.content?.[0]?.text ?? 'Done.';
    const messageId = `fake_msg_${randomUUID()}`;
    this.emit({ type: 'message_start', messageId, role: 'assistant' });
    for (const delta of chunk(text, 12)) {
      this.emit({ type: 'message_update', messageId, update: { type: 'text_delta', delta } });
      await sleep(this.chunkDelayMs);
    }
    this.emit({ type: 'message_end', messageId, role: 'assistant', text, reasoning: undefined });
    return text;
  }
}
