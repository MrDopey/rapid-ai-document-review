import type { ApplicationEvent } from '@rapid-ai-document-review/shared/contracts/events';
import { logger } from '../logging.ts';
import { newId } from '../ids.ts';
import type { EventHub } from '../events/event-hub.ts';
import type { EventService } from '../events/event-service.ts';
import type { RunBuffer } from '../events/run-buffer.ts';
import type { ToolCallMessageIdCache } from '../events/tool-call-message-id-cache.ts';
import type { ConversationStatus, StorageAdapter } from '../storage/storage-adapter.ts';
import type { AgentSessionEventLike } from './agent-session-port.ts';
import { clampWithNote } from './tools/common.ts';

/**
 * The real `@earendil-works/pi-coding-agent` `AgentSession` emits `message_start`/`message_update`/
 * `message_end` carrying a nested `message: AgentMessage` (content as text/thinking/toolCall
 * blocks, no flat `id`) and `assistantMessageEvent` deltas instead of the flat `messageId`/
 * `role`/`text`/`update` shape `AgentSessionEventLike` describes. `FakeAgentSession` (used by
 * `RADR_BE_PI_FAKE_SESSIONS=1`, which every automated test runs under) emits the flat shape directly, so
 * this mismatch never surfaces in tests — only against a live model. `normalizeRealEvent` adapts
 * the real shape down to the flat one the rest of this class (and the app's event contract)
 * expects; events already in the flat shape (from `FakeAgentSession`) pass through untouched.
 */
interface RealAgentContentBlock {
  type: 'text' | 'thinking' | 'toolCall';
  text?: string;
  thinking?: string;
}
interface RealAgentMessage {
  role: 'user' | 'assistant' | 'toolResult';
  content?: RealAgentContentBlock[];
  stopReason?: string;
  errorMessage?: string;
}
interface RealAgentSessionEvent {
  type: string;
  message?: RealAgentMessage;
  assistantMessageEvent?: { type: string; delta?: string };
  [key: string]: unknown;
}

function extractAssistantText(content: RealAgentContentBlock[] | undefined): string {
  if (!content) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

function extractAssistantReasoning(content: RealAgentContentBlock[] | undefined): string | null {
  if (!content) return null;
  const parts = content
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking ?? '');
  return parts.length > 0 ? parts.join('') : null;
}

export interface EventBridgeContext {
  documentId: string;
  conversationId: string;
  turnId: string;
}

/**
 * `propose_document_edit` (document-tools.ts) reports its proposal id via the `details` field of
 * the `AgentToolResult` it returns — the SDK-defined slot for "arbitrary structured details for
 * logs or UI rendering" — which Pi forwards verbatim as `tool_execution_end`'s `result`. A
 * top-level `stagedEditId` is also accepted for forward/back compatibility with any tool that puts
 * it there directly.
 */
function extractStagedEditId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const direct = (result as { stagedEditId?: unknown }).stagedEditId;
  if (typeof direct === 'string') return direct;
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === 'object') {
    const value = (details as { stagedEditId?: unknown }).stagedEditId;
    if (typeof value === 'string') return value;
  }
  return null;
}

/** Fixed bound on a tool call's persisted result/failure text (research.md Decision 3) — not
 *  user- or per-call-configurable, matching `tools/web-fetch.ts`'s `MAX_CONTENT_CHARS` convention. */
const MAX_TOOL_RESULT_LOG_CHARS = 20_000;

/**
 * Extracts and bounds the text content of an `AgentToolResult` (`{ content: [{ type: 'text',
 * text }], details }`) — used for both a successful call's `resultText` and a failed call's
 * `failureReason`, since either case is just "the text the tool reported," truncated the same way.
 */
function extractResultText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (block): block is { type: string; text?: string } =>
        Boolean(block) &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => block.text ?? '')
    .join('');
  if (!text) return null;
  const clamp = clampWithNote(text.length, 0, MAX_TOOL_RESULT_LOG_CHARS, 'result length');
  const truncated = text.slice(0, clamp.value);
  return clamp.note ? `${truncated}\n\n(${clamp.note})` : truncated;
}

/**
 * Translates one Pi `AgentSession`'s event stream into the application event stream, per
 * contracts/agent-tools.md §Event bridge contract — the only place Pi event types cross into the
 * rest of the backend (Constitution Principle II). One instance is created per agent turn
 * (send/refresh-send/retry) by ConversationService and discarded once the turn settles.
 *
 * `text_delta`/`thinking_delta` are ephemeral: broadcast live via EventHub and buffered in
 * RunBuffer for mid-run reconnect replay (FR-037a), but never persisted. Every other event type
 * is persisted via EventService and broadcast. Once a run has settled (agent_settled/agent_error),
 * any further event for it is logged at `warn` and discarded — it can never retroactively regain
 * a status change or a proposal (agent-tools.md §Late and orphaned events).
 */
export class EventBridge {
  private settled = false;
  private errored = false;
  private realAssistantMessageId: string | null = null;
  /** The most recently started assistant message segment's id — stays set across that segment's
   * `message_end` (not cleared there) because a tool call's `tool_execution_start`/`_end` pair
   * always arrives after the tool-call-carrier segment's own `message_end` (see
   * `event-bridge.test.ts`'s "real-SDK tool-call-carrier message segments" tests), so this is the
   * only reliable way to attribute a tool call back to the message segment that requested it. */
  private currentMessageId: string | null = null;
  private readonly cleanupFns: Array<() => void> = [];
  private readonly storage: StorageAdapter;
  private readonly eventService: EventService;
  private readonly eventHub: EventHub;
  private readonly runBuffer: RunBuffer;
  private readonly toolCallMessageIds: ToolCallMessageIdCache;
  private readonly ctx: EventBridgeContext;
  private readonly onSettle?: () => void;

  constructor(
    storage: StorageAdapter,
    eventService: EventService,
    eventHub: EventHub,
    runBuffer: RunBuffer,
    toolCallMessageIds: ToolCallMessageIdCache,
    ctx: EventBridgeContext,
    onSettle?: () => void,
  ) {
    this.storage = storage;
    this.eventService = eventService;
    this.eventHub = eventHub;
    this.runBuffer = runBuffer;
    this.toolCallMessageIds = toolCallMessageIds;
    this.ctx = ctx;
    this.onSettle = onSettle;
    // There is exactly one `RunBuffer` for the app's lifetime, so re-registering it on every turn
    // is idempotent — see `EventHub.setRunBuffer` (FR-037a).
    this.eventHub.setRunBuffer(this.runBuffer);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /** True once an `agent_error` (thrown, watchdog, or a normalized SDK failure) has been handled —
   * distinct from `isSettled`, which is also true after a normal `agent_settled`. `PiService` uses
   * this to decide whether to evict the turn's cached session, since a raw event's own `type` is
   * never `'agent_error'` for a normalized real-SDK failure (see `normalizeRealEvent`). */
  get hasErrored(): boolean {
    return this.errored;
  }

  /** Registered by PiService right after subscribing to the session; run once, on settle. */
  addCleanup(fn: () => void): void {
    if (this.settled) {
      fn();
      return;
    }
    this.cleanupFns.push(fn);
  }

  handle(rawEvent: AgentSessionEventLike): void {
    const event = this.normalizeRealEvent(rawEvent);
    if (!event) return;

    if (this.settled) {
      // No `event` field: this fires precisely because no application event will be published
      // for it — the raw Pi SDK event type has no place in the closed vocabulary (FR-042).
      logger.warn(
        {
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          piEventType: event.type,
        },
        'discarding Pi event for an already-settled run',
      );
      return;
    }

    switch (event.type) {
      case 'agent_start':
        this.setStatus('working');
        this.publish({
          type: 'agent_started',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { turnId: this.ctx.turnId },
        });
        break;

      case 'message_start':
        this.currentMessageId = event.messageId;
        this.publish({
          type: 'message_started',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { messageId: event.messageId, role: event.role },
        });
        // FR-037a: tracked so a client reconnecting mid-run can be caught up on this message's
        // partial content (EventHub.subscribe) — cleared below on `message_end`, and as a safety
        // net in `finalizeSettle` for a run that never reaches one.
        this.eventHub.registerActiveMessage(this.ctx.conversationId, {
          documentId: this.ctx.documentId,
          messageId: event.messageId,
          textKey: this.textBufferKey(event.messageId),
          reasoningKey: this.reasoningBufferKey(event.messageId),
        });
        break;

      case 'message_update':
        if (event.update.type === 'text_delta') {
          this.runBuffer.append(this.textBufferKey(event.messageId), event.update.delta);
          this.broadcastEphemeral({
            type: 'text_delta',
            sequence: null,
            documentId: this.ctx.documentId,
            conversationId: this.ctx.conversationId,
            at: new Date().toISOString(),
            data: { messageId: event.messageId, delta: event.update.delta },
          });
        } else if (event.update.type === 'thinking_delta') {
          this.runBuffer.append(this.reasoningBufferKey(event.messageId), event.update.delta);
          this.broadcastEphemeral({
            type: 'thinking_delta',
            sequence: null,
            documentId: this.ctx.documentId,
            conversationId: this.ctx.conversationId,
            at: new Date().toISOString(),
            data: { messageId: event.messageId, delta: event.update.delta },
          });
        }
        break;

      case 'message_end': {
        // The real SDK emits a whole message_start/message_end pair for a segment that carries
        // ONLY a tool call — no text, no reasoning — before the tool runs, followed by a separate
        // pair for the model's actual follow-up text once the tool result comes back. This still
        // gets a real, persisted `message_completed` event — the application event log stays a
        // complete record of what actually happened — with just the raw `text`/`reasoning` facts,
        // no tool-call-specific field. Classifying a segment as an empty "tool-call carrier" for
        // the UI to hide (`MessageDto.isToolCallCarrier`) is an interpretation, not a fact, so it's
        // computed fresh from `text`/`reasoning` at read time by `conversation-service.ts`'s
        // `buildMessages` rather than persisted here — event-sourcing: a future change to that
        // classification logic then applies to already-stored events automatically.
        this.publish({
          type: 'message_completed',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: {
            messageId: event.messageId,
            role: event.role,
            text: event.text,
            reasoning: event.reasoning ?? null,
          },
        });
        this.runBuffer.clear(this.textBufferKey(event.messageId));
        this.runBuffer.clear(this.reasoningBufferKey(event.messageId));
        this.eventHub.clearActiveMessage(this.ctx.conversationId);
        break;
      }

      case 'tool_execution_start':
        this.toolCallMessageIds.set(event.toolCallId, this.currentMessageId ?? '');
        this.publish({
          type: 'tool_started',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            messageId: this.currentMessageId ?? '',
            args: event.args,
          },
        });
        break;

      case 'tool_execution_update':
        this.broadcastEphemeral({
          type: 'tool_output_delta',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { toolCallId: event.toolCallId, delta: event.delta },
        });
        break;

      case 'tool_execution_end': {
        // Every `tool_execution_start` sets an entry (above); only `add_list_item`/
        // `update_list_item`'s own `execute()` ever consumes it via `.take()`. This `.take()`
        // guarantees every other tool call's entry is still evicted here once it settles, so the
        // cache never accumulates an unbounded number of stale entries — a harmless no-op for the
        // two tools that already consumed theirs.
        this.toolCallMessageIds.take(event.toolCallId);
        const resultText = extractResultText(event.result);
        this.publish({
          type: 'tool_completed',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            messageId: this.currentMessageId ?? '',
            isError: event.isError,
            resultText: event.isError ? null : resultText,
            failureReason: event.isError ? (resultText ?? 'Tool call failed.') : null,
            stagedEditId: extractStagedEditId(event.result),
          },
        });
        break;
      }

      case 'agent_settled':
        this.setStatus('idle');
        this.publish({
          type: 'agent_completed',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { turnId: this.ctx.turnId },
        });
        this.finalizeSettle();
        break;

      case 'agent_error':
        this.errored = true;
        this.setStatus('errored', event.message);
        this.publish({
          type: 'agent_error',
          sequence: null,
          documentId: this.ctx.documentId,
          conversationId: this.ctx.conversationId,
          at: new Date().toISOString(),
          data: { message: event.message, retryable: true },
        });
        this.finalizeSettle();
        break;

      // `agent_end` always precedes `agent_settled` for the same run (FakePiSession.completeRun,
      // and the real SDK per research R1) — acting only on `agent_settled` avoids emitting
      // `agent_completed` twice for one run. Pi's own context management is not application
      // state (Principle II), so compaction and the in-conversation steer/follow-up queue are
      // intentionally not surfaced (agent-tools.md §Event bridge contract).
      case 'agent_end':
      case 'compaction_start':
      case 'compaction_end':
      case 'queue_update':
        break;

      default:
        break;
    }
  }

  /**
   * Adapts a real `AgentSession` event (nested `message`/`assistantMessageEvent`) into the flat
   * `AgentSessionEventLike` shape the switch below expects; a `FakeAgentSession` event (already
   * flat) passes through unchanged. Returns `null` for an event that should be dropped entirely —
   * the SDK's own `message_start`/`message_end` for the *user*'s message (already recorded via
   * `ConversationService.publishUserMessage` before the turn starts, so re-publishing it here would
   * duplicate it) or a mid-stream delta with no assistant message currently tracked.
   */
  private normalizeRealEvent(rawEvent: AgentSessionEventLike): AgentSessionEventLike | null {
    const event = rawEvent as unknown as RealAgentSessionEvent;

    if (event.type === 'message_start') {
      if (!event.message) return rawEvent;
      if (event.message.role !== 'assistant') return null;
      this.realAssistantMessageId = newId('msg');
      return { type: 'message_start', messageId: this.realAssistantMessageId, role: 'assistant' };
    }

    if (event.type === 'message_update') {
      if (!event.assistantMessageEvent) return rawEvent;
      if (!this.realAssistantMessageId) return null;
      const messageId = this.realAssistantMessageId;
      const ame = event.assistantMessageEvent;
      if (ame.type === 'text_delta') {
        return {
          type: 'message_update',
          messageId,
          update: { type: 'text_delta', delta: ame.delta ?? '' },
        };
      }
      if (ame.type === 'thinking_delta') {
        return {
          type: 'message_update',
          messageId,
          update: { type: 'thinking_delta', delta: ame.delta ?? '' },
        };
      }
      return null;
    }

    if (event.type === 'message_end') {
      if (!event.message) return rawEvent;
      if (event.message.role !== 'assistant') return null;
      const messageId = this.realAssistantMessageId ?? newId('msg');
      this.realAssistantMessageId = null;
      // A model/provider failure (e.g. an API key without access to the selected model) surfaces
      // here as a normal-looking `message_end` with empty content and `stopReason: "error"` rather
      // than a distinct SDK event (the real SDK has no `agent_error` event type at all) — routed
      // through the same `agent_error` path a thrown `session.prompt()` rejection takes, so it
      // reaches the user as a visible, retryable error instead of silently rendering nothing.
      if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
        return {
          type: 'agent_error',
          message:
            event.message.errorMessage ??
            `The agent's turn ended without a response (${event.message.stopReason}).`,
        };
      }
      return {
        type: 'message_end',
        messageId,
        role: 'assistant',
        text: extractAssistantText(event.message.content),
        reasoning: extractAssistantReasoning(event.message.content) ?? undefined,
      };
    }

    return rawEvent;
  }

  private textBufferKey(messageId: string): string {
    return `${this.ctx.turnId}:${messageId}:text`;
  }

  private reasoningBufferKey(messageId: string): string {
    return `${this.ctx.turnId}:${messageId}:reasoning`;
  }

  private setStatus(status: ConversationStatus, errorMessage: string | null = null): void {
    const current = this.storage.getConversation(this.ctx.conversationId);
    if (!current || current.status === status) return;
    const previousStatus = current.status;
    this.storage.updateConversation(this.ctx.conversationId, {
      status,
      errorMessage: status === 'errored' ? errorMessage : null,
    });
    this.publish({
      type: 'conversation_status_changed',
      sequence: null,
      documentId: this.ctx.documentId,
      conversationId: this.ctx.conversationId,
      at: new Date().toISOString(),
      data: { status, previousStatus },
    });
  }

  private finalizeSettle(): void {
    if (this.settled) return;
    this.settled = true;
    this.eventHub.clearActiveMessage(this.ctx.conversationId);
    this.onSettle?.();
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns.length = 0;
  }

  private publish(frame: ApplicationEvent): void {
    const persisted = this.eventService.append(
      this.ctx.documentId,
      frame.conversationId,
      frame.type,
      frame.data,
    );
    this.eventHub.broadcast(this.ctx.documentId, {
      ...frame,
      sequence: persisted.sequence,
      at: persisted.createdAt,
    });
  }

  private broadcastEphemeral(frame: ApplicationEvent): void {
    this.eventHub.broadcast(this.ctx.documentId, frame);
  }
}
