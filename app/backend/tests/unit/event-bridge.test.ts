import { describe, expect, it } from 'vitest';
import { EventBridge } from '../../src/pi/event-bridge.js';
import { SqliteStorageAdapter } from '../../src/storage/sqlite/index.js';
import { EventService } from '../../src/events/event-service.js';
import { EventHub, type DocumentSnapshot } from '../../src/events/event-hub.js';
import { RunBuffer } from '../../src/events/run-buffer.js';
import { newId } from '../../src/ids.js';
import type { AgentSessionEventLike } from '../../src/pi/agent-session-port.js';
import type { ConversationEventRow } from '../../src/storage/storage-adapter.js';

/**
 * Regression coverage for the "blank Assistant bubble" bug: the real `@earendil-works/pi-coding-agent`
 * SDK (unlike `FakeAgentSession`, which never models this) emits a whole `message_start`/`message_end`
 * pair for a message segment that carries ONLY a `toolCall` content block — no text, no reasoning —
 * before the tool actually runs, then a SEPARATE `message_start`/`message_end` pair for the model's
 * real follow-up text once the tool result comes back.
 *
 * Fix: `EventBridge.handle()`'s `message_end` case still publishes/persists a `message_completed`
 * event for BOTH segments — the application event log stays a complete, honest record of what
 * actually happened — with just the raw `text`/`reasoning` facts, no tool-call-specific field at
 * all. Per this app's event-sourcing architecture, classifying a segment as an empty "tool-call
 * carrier" for the UI to hide (`MessageDto.isToolCallCarrier`) is an interpretation, not a fact, so
 * it's computed fresh from `text`/`reasoning` at read time by `conversation-service.ts`'s
 * `buildMessages` — see `conversation-service-tool-call-carrier.test.ts` for that. These tests just
 * prove `EventBridge` persists both segments of a tool-call turn as distinct, honest events.
 */

interface Harness {
  storage: SqliteStorageAdapter;
  eventService: EventService;
  eventHub: EventHub;
  bridge: EventBridge;
  documentId: string;
  conversationId: string;
}

function buildHarness(): Harness {
  const storage = new SqliteStorageAdapter(':memory:');
  const eventService = new EventService(storage);
  const emptySnapshot: DocumentSnapshot = {
    document: { id: '', title: '', currentRevision: 0, createdAt: '', updatedAt: '', content: '' },
    conversations: [],
  };
  const eventHub = new EventHub(eventService, () => emptySnapshot);
  const runBuffer = new RunBuffer();

  const now = new Date().toISOString();
  const documentId = newId('doc');
  storage.createDocument({
    id: documentId,
    title: 'Fixture',
    piSessionDir: '/tmp/pi-sessions',
    createdAt: now,
    updatedAt: now,
  });

  const conversationId = newId('conv');
  storage.createConversation({
    id: conversationId,
    documentId,
    parentId: null,
    name: 'Main',
    kind: 'main',
    piSessionPath: `/tmp/${conversationId}.jsonl`,
    status: 'idle',
    errorMessage: null,
    isPrimary: true,
    contextRevision: 1,
    branchDepth: 0,
    seedSelection: null,
    forkedFromMessageId: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  });

  const bridge = new EventBridge(storage, eventService, eventHub, runBuffer, {
    documentId,
    conversationId,
    turnId: newId('turn'),
  });

  return { storage, eventService, eventHub, bridge, documentId, conversationId };
}

function messageCompletedEvents(h: Harness): ConversationEventRow[] {
  return h.storage
    .listEventsSince(h.documentId, null)
    .filter((row) => row.eventType === 'message_completed');
}

/** Real-SDK-shaped raw event, as `AgentSession.subscribe` would actually deliver it — opaque to
 * `AgentSessionEventLike`'s flat type at compile time, adapted by `EventBridge.normalizeRealEvent`
 * at runtime exactly as a live session's events are (see `pi-service.ts`'s `session.subscribe`). */
function real(event: Record<string, unknown>): AgentSessionEventLike {
  return event as unknown as AgentSessionEventLike;
}

describe('EventBridge: real-SDK tool-call-carrier message segments', () => {
  it('publishes/persists a message_completed for BOTH SDK message segments of a tool-call turn, with no isToolCallCarrier/hasToolCall field', () => {
    const h = buildHarness();

    h.bridge.handle(real({ type: 'agent_start' }));

    // Segment 1: tool-call-only carrier — no text, no reasoning.
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(
      real({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', toolCallId: 'tc_1', toolName: 'read_document' }],
        },
      }),
    );

    h.bridge.handle(
      real({ type: 'tool_execution_start', toolCallId: 'tc_1', toolName: 'read_document' }),
    );
    h.bridge.handle(
      real({
        type: 'tool_execution_end',
        toolCallId: 'tc_1',
        toolName: 'read_document',
        isError: false,
        result: {},
      }),
    );

    // Segment 2: the model's real follow-up text.
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(
      real({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is what the document says.' }],
        },
      }),
    );

    h.bridge.handle(real({ type: 'agent_settled' }));

    // Both segments are real, persisted events — nothing is dropped from the log.
    const completed = messageCompletedEvents(h);
    expect(completed).toHaveLength(2);

    const [carrier, reply] = completed;
    expect(carrier!.data).toMatchObject({ text: '' });
    expect(carrier!.data).not.toHaveProperty('isToolCallCarrier');
    expect(carrier!.data).not.toHaveProperty('hasToolCall');
    expect(reply!.data).toMatchObject({ text: 'Here is what the document says.' });
  });

  it('persists a reasoning-only segment with its raw reasoning text intact', () => {
    const h = buildHarness();
    h.storage.updateSettings({ thinkingVisible: true }, new Date().toISOString());

    h.bridge.handle(real({ type: 'agent_start' }));
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(
      real({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Mulling it over.' }],
        },
      }),
    );
    h.bridge.handle(real({ type: 'agent_settled' }));

    const completed = messageCompletedEvents(h);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data).toMatchObject({ text: '', reasoning: 'Mulling it over.' });
  });

  it('persists a genuinely empty final answer (no tool call, no reasoning) with empty text', () => {
    const h = buildHarness();

    h.bridge.handle(real({ type: 'agent_start' }));
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(real({ type: 'message_end', message: { role: 'assistant', content: [] } }));
    h.bridge.handle(real({ type: 'agent_settled' }));

    const completed = messageCompletedEvents(h);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data).toMatchObject({ text: '' });
  });

  it('FakeAgentSession-style flat message_end events persist through unchanged', () => {
    const h = buildHarness();

    h.bridge.handle({ type: 'agent_start' });
    h.bridge.handle({ type: 'message_start', messageId: 'fake_msg_1', role: 'assistant' });
    h.bridge.handle({
      type: 'message_end',
      messageId: 'fake_msg_1',
      role: 'assistant',
      text: 'hi',
      reasoning: undefined,
    });
    h.bridge.handle({ type: 'agent_settled' });

    const completed = messageCompletedEvents(h);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data).toMatchObject({ text: 'hi' });
  });
});

describe('EventBridge: reasoning and tool-call detail are always captured (009-agent-activity-logging)', () => {
  it('persists message_completed.data.reasoning even when thinkingVisible is off', () => {
    const h = buildHarness();
    h.storage.updateSettings({ thinkingVisible: false }, new Date().toISOString());

    h.bridge.handle(real({ type: 'agent_start' }));
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(
      real({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Mulling it over.' },
            { type: 'text', text: 'Here you go.' },
          ],
        },
      }),
    );
    h.bridge.handle(real({ type: 'agent_settled' }));

    const completed = messageCompletedEvents(h);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data).toMatchObject({
      text: 'Here you go.',
      reasoning: 'Mulling it over.',
    });
  });

  it('tool_started carries messageId/args, and tool_completed carries messageId/resultText for a successful call', () => {
    const h = buildHarness();

    h.bridge.handle(real({ type: 'agent_start' }));
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(
      real({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', toolCallId: 'tc_1', toolName: 'web_search' }],
        },
      }),
    );
    h.bridge.handle(
      real({
        type: 'tool_execution_start',
        toolCallId: 'tc_1',
        toolName: 'web_search',
        args: { query: 'rapid ai document review' },
      }),
    );
    h.bridge.handle(
      real({
        type: 'tool_execution_end',
        toolCallId: 'tc_1',
        toolName: 'web_search',
        isError: false,
        result: { content: [{ type: 'text', text: 'Web search: 1 result' }] },
      }),
    );
    h.bridge.handle(real({ type: 'agent_settled' }));

    const started = h.storage
      .listEventsSince(h.documentId, null)
      .find((row) => row.eventType === 'tool_started');
    const completed = h.storage
      .listEventsSince(h.documentId, null)
      .find((row) => row.eventType === 'tool_completed');

    expect(started!.data).toMatchObject({
      toolCallId: 'tc_1',
      args: { query: 'rapid ai document review' },
    });
    expect((started!.data as { messageId: string }).messageId).toBeTruthy();
    expect((started!.data as { messageId: string }).messageId).toEqual(
      (completed!.data as { messageId: string }).messageId,
    );
    expect(completed!.data).toMatchObject({
      resultText: 'Web search: 1 result',
      failureReason: null,
    });
  });

  it('tool_completed carries failureReason (not resultText) when a tool call errors', () => {
    const h = buildHarness();

    h.bridge.handle(real({ type: 'agent_start' }));
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(
      real({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', toolCallId: 'tc_2', toolName: 'web_fetch' }],
        },
      }),
    );
    h.bridge.handle(
      real({
        type: 'tool_execution_start',
        toolCallId: 'tc_2',
        toolName: 'web_fetch',
        args: { url: 'https://example.invalid' },
      }),
    );
    h.bridge.handle(
      real({
        type: 'tool_execution_end',
        toolCallId: 'tc_2',
        toolName: 'web_fetch',
        isError: true,
        result: { content: [{ type: 'text', text: 'Could not fetch: timed out' }] },
      }),
    );
    h.bridge.handle(real({ type: 'agent_settled' }));

    const completed = h.storage
      .listEventsSince(h.documentId, null)
      .find((row) => row.eventType === 'tool_completed');

    expect(completed!.data).toMatchObject({
      resultText: null,
      failureReason: 'Could not fetch: timed out',
    });
  });

  it('bounds resultText at a fixed size, ending with a truncation marker (FR-007/SC-004)', () => {
    const h = buildHarness();
    const hugeText = 'x'.repeat(25_000);

    h.bridge.handle(real({ type: 'agent_start' }));
    h.bridge.handle(real({ type: 'message_start', message: { role: 'assistant' } }));
    h.bridge.handle(
      real({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', toolCallId: 'tc_3', toolName: 'web_fetch' }],
        },
      }),
    );
    h.bridge.handle(
      real({
        type: 'tool_execution_start',
        toolCallId: 'tc_3',
        toolName: 'web_fetch',
        args: { url: 'https://example.com/huge' },
      }),
    );
    h.bridge.handle(
      real({
        type: 'tool_execution_end',
        toolCallId: 'tc_3',
        toolName: 'web_fetch',
        isError: false,
        result: { content: [{ type: 'text', text: hugeText }] },
      }),
    );
    h.bridge.handle(real({ type: 'agent_settled' }));

    const completed = h.storage
      .listEventsSince(h.documentId, null)
      .find((row) => row.eventType === 'tool_completed');
    const resultText = (completed!.data as { resultText: string }).resultText;

    expect(resultText.length).toBeLessThan(hugeText.length);
    expect(resultText).toMatch(/clamped/);
  });
});
