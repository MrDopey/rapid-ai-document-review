import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ApplicationEvent,
  EPHEMERAL_EVENT_TYPES,
  SubscribedFrame,
} from '@rapid-ai-document-review/shared/contracts/events';
import { GetConversationResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { createTestApp, listenForWs, waitFor } from './test-app.js';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';
import type { DocumentSnapshot, SocketLike } from '../../src/events/event-hub.js';

/**
 * Black-box WebSocket contract tests (T086, contracts/websocket-events.md). Most tests connect a
 * real `WebSocket` (Node's global client) to a real, listening Fastify instance built by
 * `createTestApp()`/`listenForWs()` — the same `RADR_BE_PI_FAKE_SESSIONS=1` in-memory-SQLite harness as
 * http.test.ts. The one exception is the backpressure test (ordering guarantee 6's "only ephemeral
 * frames are dropped" half): simulating genuine TCP backpressure over a real loopback socket is
 * inherently flaky in a test environment, so that one exercises `EventHub`'s drop logic directly
 * with a fake `SocketLike`, per the task's explicit allowance to pick whichever is more reliable.
 */

const PROPOSE_EDIT_DIRECTIVE = '__PROPOSE_DOCUMENT_EDIT__';
function proposeDirective(
  summary: string,
  operations: { old_string: string; new_string: string }[],
): string {
  return PROPOSE_EDIT_DIRECTIVE + JSON.stringify({ summary, operations });
}

interface Frame {
  type: string;
  sequence: number | null;
  documentId: string;
  conversationId: string | null;
  at: string;
  data: unknown;
}

async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method, url, payload: payload as never });
  let json: unknown;
  try {
    json = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json };
}

/** Opens a real WebSocket to `/events`, sends the initial `subscribe` frame, and waits for the
 *  `subscribed` reply — mirroring the handshake in websocket-events.md §Handshake and replay. */
async function openSocket(
  baseUrl: string,
  documentId: string,
  sinceSequence: number | null,
): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const ws = new WebSocket(`${baseUrl}/events`);
  const frames: Frame[] = [];
  ws.addEventListener('message', (ev) => {
    frames.push(JSON.parse(String(ev.data)) as Frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(e), { once: true });
  });
  ws.send(JSON.stringify({ type: 'subscribe', documentId, sinceSequence }));
  await waitFor(() => frames.some((f) => f.type === 'subscribed'), {
    message: 'never received "subscribed"',
  });
  return { ws, frames };
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.addEventListener('close', () => resolve(), { once: true });
    ws.close();
  });
}

const DOC_WITH_HEADING = [
  '# Quarterly Strategy',
  '',
  'The opening paragraph anchors everything else.',
  '',
  'A second paragraph stays constant across scenarios.',
  '',
  'Trailing unique tail xyz123.',
].join('\n');

async function createDoc(app: FastifyInstance, content: string = DOC_WITH_HEADING) {
  const res = await call(app, 'POST', '/api/documents', { content });
  expect(res.status).toBe(201);
  return res.json as { document: { id: string }; mainConversation: { id: string } };
}

async function branchAndSettle(
  app: FastifyInstance,
  storage: StorageAdapter,
  documentId: string,
  parentConversationId: string,
): Promise<string> {
  const res = await call(app, 'POST', `/api/documents/${documentId}/conversations`, {
    parentConversationId,
  });
  expect(res.status).toBe(201);
  const id = (res.json as { id: string }).id;
  await waitFor(() => storage.getConversation(id)?.status === 'idle');
  return id;
}

async function setup() {
  const { app, storage } = await createTestApp();
  const baseUrl = await listenForWs(app);
  return { app, storage, baseUrl };
}

describe('Contract: WebSocket event stream (websocket-events.md)', () => {
  it('validates the "subscribed" handshake frame and document_created/revision_created against the shared schemas', async () => {
    // The `/events` subscribe handler (ws/index.ts) no-ops when there is no document yet — there
    // is nothing to snapshot — so a document must exist before the handshake can complete at all.
    // `document_created`/the creation `revision_created` are therefore validated from the
    // persisted event rows directly rather than via live socket delivery.
    const { app, storage, baseUrl } = await setup();
    const created = await createDoc(app);
    const { ws, frames } = await openSocket(baseUrl, created.document.id, null);
    try {
      const subscribed = SubscribedFrame.parse(frames.find((f) => f.type === 'subscribed'));
      expect(subscribed.replayCount).toBe(0); // sinceSequence: null requests no replay
      expect(subscribed.snapshot.document.currentRevision).toBe(1);

      const rows = storage.listEventsSince(created.document.id, null);
      const documentCreatedRow = rows.find((r) => r.eventType === 'document_created')!;
      const revisionCreatedRow = rows.find((r) => r.eventType === 'revision_created')!;
      expect(
        ApplicationEvent.parse({
          type: documentCreatedRow.eventType,
          sequence: documentCreatedRow.sequence,
          documentId: documentCreatedRow.documentId,
          conversationId: documentCreatedRow.conversationId,
          at: documentCreatedRow.createdAt,
          data: documentCreatedRow.data,
        }).type,
      ).toBe('document_created');
      expect(
        ApplicationEvent.parse({
          type: revisionCreatedRow.eventType,
          sequence: revisionCreatedRow.sequence,
          documentId: revisionCreatedRow.documentId,
          conversationId: revisionCreatedRow.conversationId,
          at: revisionCreatedRow.createdAt,
          data: revisionCreatedRow.data,
        }).type,
      ).toBe('revision_created');
    } finally {
      await closeSocket(ws);
      await app.close();
    }
  });

  it('an unknown event type is rejected by the schema, not ignored', () => {
    expect(() =>
      ApplicationEvent.parse({
        type: 'made_up_event_type',
        sequence: 1,
        documentId: 'doc_x',
        conversationId: null,
        at: new Date().toISOString(),
        data: {},
      }),
    ).toThrow();
  });

  it('end-to-end flow validates every emitted event type, and asserts ordering guarantees 2, 7 and 8', async () => {
    const { app, storage, baseUrl } = await setup();
    const created = await createDoc(app);
    const mainId = created.mainConversation.id;
    const { ws, frames } = await openSocket(baseUrl, created.document.id, null);
    try {
      // thinkingVisible on, to also exercise thinking_delta.
      await call(app, 'PATCH', '/api/settings', { thinkingVisible: true });
      await waitFor(() => frames.some((f) => f.type === 'settings_changed'));

      // --- Non-Primary staged proposal, applied cleanly ---
      const branchId = await branchAndSettle(app, storage, created.document.id, mainId);
      await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/conversations/${branchId}/send`,
        {
          message: proposeDirective('tweak', [
            {
              old_string: 'Trailing unique tail xyz123.',
              new_string: 'Trailing unique tail changed.',
            },
          ]),
        },
      );
      await waitFor(() => storage.listStagedEditsByConversation(branchId).length === 1);
      await waitFor(() => storage.getConversation(branchId)?.status === 'idle');
      const stagedNonPrimary = storage.listStagedEditsByConversation(branchId)[0]!;
      await waitFor(() => frames.some((f) => f.type === 'staged_edit_created'));

      const applyRes = await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/edits/${stagedNonPrimary.id}/apply`,
        {},
      );
      expect((applyRes.json as { outcome: string }).outcome).toBe('applied');
      await waitFor(() => frames.some((f) => f.type === 'staged_edit_applied'));
      await waitFor(() => frames.some((f) => f.type === 'document_content_changed'));

      // Guarantee 2 (non-Primary): staged_edit_created precedes staged_edit_applied for the
      // same stagedEditId.
      const createdIdxNonPrimary = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_created' &&
          (f.data as { stagedEditId: string }).stagedEditId === stagedNonPrimary.id,
      );
      const appliedIdxNonPrimary = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_applied' &&
          (f.data as { stagedEditId: string }).stagedEditId === stagedNonPrimary.id,
      );
      expect(createdIdxNonPrimary).toBeGreaterThanOrEqual(0);
      expect(appliedIdxNonPrimary).toBeGreaterThan(createdIdxNonPrimary);

      // Guarantee 4: staged_edit_applied precedes document_content_changed/revision_created it causes.
      const contentChangedIdx = frames.findIndex((f) => f.type === 'document_content_changed');
      expect(contentChangedIdx).toBeGreaterThan(appliedIdxNonPrimary);

      // --- Primary auto-apply path (Main is Primary by default) ---
      await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/conversations/${mainId}/send`,
        {
          message: proposeDirective('primary tweak', [
            {
              old_string: 'A second paragraph stays constant across scenarios.',
              new_string: 'A second paragraph now differs.',
            },
          ]),
        },
      );
      await waitFor(() => storage.listStagedEditsByConversation(mainId).length === 1);
      await waitFor(() => storage.getConversation(mainId)?.status === 'idle');
      const stagedPrimary = storage.listStagedEditsByConversation(mainId)[0]!;
      expect(stagedPrimary.autoApplied).toBe(true);
      expect(stagedPrimary.status).toBe('applied');

      const createdIdxPrimary = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_created' &&
          (f.data as { stagedEditId: string }).stagedEditId === stagedPrimary.id,
      );
      const appliedIdxPrimary = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_applied' &&
          (f.data as { stagedEditId: string }).stagedEditId === stagedPrimary.id,
      );
      // Guarantee 2, Primary auto-apply path: staged_edit_created still precedes the verdict
      // even though both happen within the same synchronous tool call (SC-004).
      expect(createdIdxPrimary).toBeGreaterThanOrEqual(0);
      expect(appliedIdxPrimary).toBeGreaterThan(createdIdxPrimary);
      expect((frames[appliedIdxPrimary]!.data as { autoApplied: boolean }).autoApplied).toBe(true);

      // Guarantee 8: agent_started precedes any staged_edit_created produced by a tool call in
      // that same run, for both proposals above (and implicitly every other run in this test).
      for (const editId of [stagedNonPrimary.id, stagedPrimary.id]) {
        const scIdx = frames.findIndex(
          (f) =>
            f.type === 'staged_edit_created' &&
            (f.data as { stagedEditId: string }).stagedEditId === editId,
        );
        const conversationId = frames[scIdx]!.conversationId!;
        // The most recent agent_started for this conversation before the proposal.
        let lastAgentStarted = -1;
        let lastAgentCompleted = -1;
        for (let i = 0; i < scIdx; i += 1) {
          const f = frames[i]!;
          if (f.conversationId !== conversationId) continue;
          if (f.type === 'agent_started') lastAgentStarted = i;
          if (f.type === 'agent_completed' || f.type === 'agent_error') lastAgentCompleted = i;
        }
        expect(lastAgentStarted).toBeGreaterThanOrEqual(0);
        expect(lastAgentStarted).toBeGreaterThan(lastAgentCompleted); // still inside that run
      }

      // --- Conflict, budget exhausted on first conflict (maxReplacementAttempts: 0) ---
      await call(app, 'PATCH', '/api/settings', { maxReplacementAttempts: 0 });
      const branch2Id = await branchAndSettle(app, storage, created.document.id, mainId);
      await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/conversations/${branch2Id}/send`,
        {
          message: proposeDirective('conflict target', [
            {
              old_string: 'The opening paragraph anchors everything else.',
              new_string: 'Something new.',
            },
          ]),
        },
      );
      await waitFor(() => storage.listStagedEditsByConversation(branch2Id).length === 1);
      await waitFor(() => storage.getConversation(branch2Id)?.status === 'idle');
      const edit1 = storage.listStagedEditsByConversation(branch2Id)[0]!;
      await call(app, 'PATCH', `/api/documents/${created.document.id}`, {
        changes: [
          {
            from: 0,
            to: 5000,
            insert: DOC_WITH_HEADING.replace(
              'The opening paragraph anchors everything else.',
              'A drifted paragraph.',
            ),
          },
        ],
      });
      const exhaustedRes = await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/edits/${edit1.id}/apply`,
        {},
      );
      expect((exhaustedRes.json as { outcome: string }).outcome).toBe('conflict_exhausted');
      await waitFor(() =>
        frames.some(
          (f) =>
            f.type === 'staged_edit_replacement_exhausted' &&
            (f.data as { stagedEditId: string }).stagedEditId === edit1.id,
        ),
      );
      const supersededIdx1 = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_superseded' &&
          (f.data as { stagedEditId: string }).stagedEditId === edit1.id,
      );
      const exhaustedIdx = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_replacement_exhausted' &&
          (f.data as { stagedEditId: string }).stagedEditId === edit1.id,
      );
      // Guarantee 7 (exhausted branch): staged_edit_superseded precedes staged_edit_replacement_exhausted.
      expect(supersededIdx1).toBeGreaterThanOrEqual(0);
      expect(exhaustedIdx).toBeGreaterThan(supersededIdx1);
      expect(
        (frames[supersededIdx1]!.data as { replacementRequested: boolean }).replacementRequested,
      ).toBe(false);

      // --- Conflict, then an agent-produced replacement (default budget) ---
      await call(app, 'PATCH', '/api/settings', { maxReplacementAttempts: 2 });
      const branch3Id = await branchAndSettle(app, storage, created.document.id, mainId);
      await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/conversations/${branch3Id}/send`,
        {
          message: proposeDirective('conflict target 2', [
            {
              old_string: 'Trailing unique tail changed.',
              new_string: 'Trailing unique tail from branch3.',
            },
          ]),
        },
      );
      await waitFor(() => storage.listStagedEditsByConversation(branch3Id).length === 1);
      await waitFor(() => storage.getConversation(branch3Id)?.status === 'idle');
      const edit2 = storage.listStagedEditsByConversation(branch3Id)[0]!;
      const liveContent = (await call(
        app,
        'GET',
        `/api/documents/${created.document.id}`,
      )) as unknown as {
        json: { content: string };
      };
      const currentContent = (liveContent.json as { content: string }).content;
      await call(app, 'PATCH', `/api/documents/${created.document.id}`, {
        changes: [
          {
            from: 0,
            to: currentContent.length,
            insert: currentContent.replace('Trailing unique tail changed.', 'Drifted again.'),
          },
        ],
      });
      const conflictRes = await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/edits/${edit2.id}/apply`,
        {},
      );
      expect((conflictRes.json as { outcome: string }).outcome).toBe('conflict');
      await waitFor(() => storage.getConversation(branch3Id)?.status === 'idle');

      // The conversation's next proposal automatically becomes edit2's replacement.
      await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/conversations/${branch3Id}/send`,
        {
          message: proposeDirective('replacement', [
            { old_string: 'Drifted again.', new_string: 'Drifted again, fixed.' },
          ]),
        },
      );
      await waitFor(() =>
        frames.some(
          (f) =>
            f.type === 'staged_edit_replacement_created' &&
            (f.data as { supersedesId: string }).supersedesId === edit2.id,
        ),
      );
      const supersededIdx2 = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_superseded' &&
          (f.data as { stagedEditId: string }).stagedEditId === edit2.id,
      );
      const replacementCreatedIdx = frames.findIndex(
        (f) =>
          f.type === 'staged_edit_replacement_created' &&
          (f.data as { supersedesId: string }).supersedesId === edit2.id,
      );
      // Guarantee 7 (replacement branch): staged_edit_superseded precedes staged_edit_replacement_created.
      expect(supersededIdx2).toBeGreaterThanOrEqual(0);
      expect(replacementCreatedIdx).toBeGreaterThan(supersededIdx2);

      // --- Every non-control frame observed validates against the discriminated union ---
      const observedTypes = new Set<string>();
      for (const frame of frames) {
        if (frame.type === 'subscribed' || frame.type === 'pong') continue;
        const parsed = ApplicationEvent.parse(frame); // throws on drift
        observedTypes.add(parsed.type);
      }
      // A representative slice of the vocabulary this flow should have driven end to end.
      // (document_created is not observable live here — see the handshake test above — since
      // the document must already exist before a socket's subscribe can complete at all.)
      for (const expectedType of [
        'revision_created',
        'settings_changed',
        'conversation_started',
        'conversation_status_changed',
        'agent_started',
        'agent_completed',
        'message_started',
        'message_completed',
        'tool_started',
        'tool_completed',
        'staged_edit_created',
        'staged_edit_applied',
        'staged_edit_superseded',
        'staged_edit_replacement_created',
        'staged_edit_replacement_exhausted',
        'document_content_changed',
      ]) {
        expect(observedTypes.has(expectedType), `expected to have observed "${expectedType}"`).toBe(
          true,
        );
      }
      expect(observedTypes.has('thinking_delta')).toBe(true);
      expect(observedTypes.has('text_delta')).toBe(true);
    } finally {
      await closeSocket(ws);
      await app.close();
    }
  }, 20_000);

  it('document_content_changed.contentHash matches SHA-256 of the resulting content', async () => {
    const { app, storage, baseUrl } = await setup();
    const created = await createDoc(app);
    const { ws, frames } = await openSocket(baseUrl, created.document.id, null);
    try {
      await call(app, 'PATCH', `/api/documents/${created.document.id}`, {
        changes: [{ from: 0, to: 0, insert: '## ' }],
      });
      await waitFor(() => frames.some((f) => f.type === 'document_content_changed'));

      const frame = frames.find((f) => f.type === 'document_content_changed')!;
      const doc = await call(app, 'GET', `/api/documents/${created.document.id}`);
      const content = (doc.json as { content: string }).content;
      const expectedHash = createHash('sha256').update(content).digest('hex');
      expect((frame.data as { contentHash: string }).contentHash).toBe(expectedHash);
      void created;
      void storage;
    } finally {
      await closeSocket(ws);
      await app.close();
    }
  });

  it('reconnect replay is gap-free and non-duplicating (FR-037)', async () => {
    const { app, storage, baseUrl } = await setup();
    const created = await createDoc(app);
    const first = await openSocket(baseUrl, created.document.id, null);
    const subscribedFirst = SubscribedFrame.parse(
      first.frames.find((f) => f.type === 'subscribed'),
    );
    const lastSeenSequence = subscribedFirst.currentSequence;

    // Generate more persisted events while "disconnected" (socket #1 is closed first).
    await closeSocket(first.ws);
    const branchId = await branchAndSettle(
      app,
      storage,
      created.document.id,
      created.mainConversation.id,
    );
    await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations/${branchId}/close`,
      {},
    );
    const afterSequence = storage.getLatestSequence(created.document.id);
    expect(afterSequence).toBeGreaterThan(lastSeenSequence);

    const second = await openSocket(baseUrl, created.document.id, lastSeenSequence);
    const subscribedSecond = SubscribedFrame.parse(
      second.frames.find((f) => f.type === 'subscribed'),
    );
    expect(subscribedSecond.currentSequence).toBe(afterSequence);
    expect(subscribedSecond.replayCount).toBe(afterSequence - lastSeenSequence);

    await waitFor(() => second.frames.length >= 1 + subscribedSecond.replayCount);
    const replayed = second.frames.filter((f) => f.type !== 'subscribed');
    const sequences = replayed.map((f) => f.sequence).filter((s): s is number => s !== null);
    // Gap-free, strictly increasing, starting right after what socket #1 last saw.
    for (let i = 0; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe(lastSeenSequence + 1 + i);
    }
    expect(new Set(sequences).size).toBe(sequences.length); // no duplicates
    expect(sequences.at(-1)).toBe(afterSequence);

    await closeSocket(second.ws);
    await app.close();
  });

  it('reconnect with sinceSequence ahead of currentSequence converges via the snapshot (replayCount 0)', async () => {
    const { app, baseUrl } = await setup();
    const created = await createDoc(app);
    const { ws, frames } = await openSocket(baseUrl, created.document.id, 999_999);
    try {
      const subscribed = SubscribedFrame.parse(frames.find((f) => f.type === 'subscribed'));
      expect(subscribed.replayCount).toBe(0);
      expect(subscribed.snapshot.document.currentRevision).toBe(1);
    } finally {
      await closeSocket(ws);
      await app.close();
    }
  });

  it('FR-037a: a mid-run reconnect replays the partial buffered text before any subsequent delta', async () => {
    const { app, storage, baseUrl } = await setup();
    const created = await createDoc(app);
    await call(app, 'PATCH', '/api/settings', { thinkingVisible: true });

    const first = await openSocket(baseUrl, created.document.id, null);
    // Kick off a plain (non-directive) send, which streams thinking + text deltas with small
    // artificial delays (fake-agent-session.ts) — giving us a real window to reconnect mid-run.
    await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations/${created.mainConversation.id}/send`,
      {
        message:
          'Please write a fairly long answer so streaming has time to be observed mid-flight.',
      },
    );
    await waitFor(() => first.frames.some((f) => f.type === 'text_delta'));
    await closeSocket(first.ws);

    // Reconnect while the run is still in progress.
    expect(storage.getConversation(created.mainConversation.id)?.status).toBe('working');
    const second = await openSocket(baseUrl, created.document.id, null);
    try {
      // The synthesized catch-up frame(s) must appear immediately after "subscribed", before any
      // further live delta this new socket receives.
      await waitFor(() => second.frames.length >= 2, {
        message: 'no catch-up frame arrived after subscribed',
      });
      const afterSubscribed = second.frames[1]!;
      expect(['text_delta', 'thinking_delta']).toContain(afterSubscribed.type);
      expect(typeof (afterSubscribed.data as { delta: string }).delta).toBe('string');
      expect((afterSubscribed.data as { delta: string }).delta.length).toBeGreaterThan(0);

      await waitFor(() => storage.getConversation(created.mainConversation.id)?.status === 'idle');
      await waitFor(() => second.frames.some((f) => f.type === 'message_completed'));
    } finally {
      await closeSocket(second.ws);
      await app.close();
    }
  });

  it('thinking_delta frames are emitted identically whether thinkingVisible is true or false (009-agent-activity-logging: capture is no longer gated by display setting)', async () => {
    const { app, storage, baseUrl } = await setup();
    const created = await createDoc(app);
    await call(app, 'PATCH', '/api/settings', { thinkingVisible: false });
    const { ws, frames } = await openSocket(baseUrl, created.document.id, null);
    try {
      await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/conversations/${created.mainConversation.id}/send`,
        {
          message: 'Please answer so reasoning deltas stream for a moment.',
        },
      );
      await waitFor(() => frames.some((f) => f.type === 'thinking_delta'));
      await waitFor(() => storage.getConversation(created.mainConversation.id)?.status === 'idle');

      const thinkingWhileOff = frames.filter((f) => f.type === 'thinking_delta');
      expect(thinkingWhileOff.length).toBeGreaterThanOrEqual(1);
    } finally {
      await closeSocket(ws);
      await app.close();
    }
  });

  it("toggling thinkingVisible on retroactively reveals a past turn's reasoning with no re-run (FR-006/SC-002, 009-agent-activity-logging)", async () => {
    const { app, storage } = await setup();
    const created = await createDoc(app);
    await call(app, 'PATCH', '/api/settings', { thinkingVisible: false });

    await call(
      app,
      'POST',
      `/api/documents/${created.document.id}/conversations/${created.mainConversation.id}/send`,
      {
        message: 'Please answer so reasoning is produced.',
      },
    );
    await waitFor(() => storage.getConversation(created.mainConversation.id)?.status === 'idle');

    const beforeToggle = GetConversationResponse.parse(
      (
        await call(
          app,
          'GET',
          `/api/documents/${created.document.id}/conversations/${created.mainConversation.id}`,
        )
      ).json,
    );
    const assistantMessage = beforeToggle.messages.find(
      (m) => m.role === 'assistant' && !m.isToolCallCarrier,
    );
    // Reasoning is captured regardless of the display setting (FR-001) — already present in the
    // GET response even while `thinkingVisible` is off.
    expect(assistantMessage?.reasoning).toBeTruthy();

    await call(app, 'PATCH', '/api/settings', { thinkingVisible: true });

    const afterToggle = GetConversationResponse.parse(
      (
        await call(
          app,
          'GET',
          `/api/documents/${created.document.id}/conversations/${created.mainConversation.id}`,
        )
      ).json,
    );
    const sameMessage = afterToggle.messages.find((m) => m.id === assistantMessage?.id);
    expect(sameMessage?.reasoning).toBe(assistantMessage?.reasoning);

    await app.close();
  });

  it('ephemeral event types never appear in persisted conversation_event rows', async () => {
    const { app, storage, baseUrl } = await setup();
    const created = await createDoc(app);
    await call(app, 'PATCH', '/api/settings', { thinkingVisible: true });
    const { ws, frames } = await openSocket(baseUrl, created.document.id, null);
    try {
      await call(
        app,
        'POST',
        `/api/documents/${created.document.id}/conversations/${created.mainConversation.id}/send`,
        {
          message: 'A message that streams both thinking and text deltas.',
        },
      );
      await waitFor(() => frames.some((f) => f.type === 'thinking_delta'));
      await waitFor(() => frames.some((f) => f.type === 'text_delta'));
      await waitFor(() => storage.getConversation(created.mainConversation.id)?.status === 'idle');

      // The live socket actually received ephemeral frames (sanity check the scenario is real)...
      expect(frames.some((f) => EPHEMERAL_EVENT_TYPES.includes(f.type))).toBe(true);

      // ...but none of them made it into the persisted event log.
      const persisted = storage.listEventsSince(created.document.id, null);
      expect(
        persisted.some((row) =>
          (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(row.eventType),
        ),
      ).toBe(false);
      expect(persisted.some((row) => row.eventType === 'message_completed')).toBe(true);
    } finally {
      await closeSocket(ws);
      await app.close();
    }
  });

  it('two simultaneously connected clients both receive document_content_changed for a manual edit (FR-003)', async () => {
    const { app, baseUrl } = await setup();
    const created = await createDoc(app);
    const a = await openSocket(baseUrl, created.document.id, null);
    const b = await openSocket(baseUrl, created.document.id, null);
    try {
      await call(app, 'PATCH', `/api/documents/${created.document.id}`, {
        changes: [{ from: 0, to: 0, insert: '## ' }],
      });
      await waitFor(() => a.frames.some((f) => f.type === 'document_content_changed'));
      await waitFor(() => b.frames.some((f) => f.type === 'document_content_changed'));
    } finally {
      await closeSocket(a.ws);
      await closeSocket(b.ws);
      await app.close();
    }
  });

  it(
    'ordering guarantee 6: only ephemeral frame types are dropped once bufferedAmount exceeds 1MB ' +
      '(unit-level against EventHub directly, since simulating real TCP backpressure over loopback is unreliable in a test environment)',
    async () => {
      // Dynamically imported (rather than statically at the top of the file, alongside
      // `createTestApp`) deliberately: `EventHub` pulls in `logging.js` -> `config.js`, and a
      // *static* import evaluates before any test body runs — including before `createTestApp()`
      // ever gets a chance to set `RADR_BE_DATABASE_PATH`/`RADR_BE_PI_FAKE_SESSIONS` — which would permanently
      // poison the cached `config` singleton for every other test in this file with the wrong
      // (default, real-path / non-fake) values. This test doesn't touch `config` at all (it builds
      // its own `SqliteStorageAdapter(':memory:')` directly), so a dynamic import costs nothing.
      const { EventHub } = await import('../../src/events/event-hub.js');
      const { EventService } = await import('../../src/events/event-service.js');
      const { SqliteStorageAdapter } = await import('../../src/storage/sqlite/index.js');
      const storage = new SqliteStorageAdapter(':memory:');
      const eventService = new EventService(storage);
      const emptySnapshot: DocumentSnapshot = {
        document: {
          id: 'doc_x',
          title: '',
          currentRevision: 0,
          createdAt: '',
          updatedAt: '',
          content: '',
        },
        conversations: [],
      };
      const eventHub = new EventHub(eventService, () => emptySnapshot);

      const sent: string[] = [];
      let bufferedAmount = 2_000_000; // above the 1MB threshold
      const fakeSocket: SocketLike = {
        readyState: 1,
        get bufferedAmount() {
          return bufferedAmount;
        },
        send(data: string) {
          sent.push(data);
        },
      };
      eventHub.subscribe(fakeSocket, 'doc_x', null); // consumes the initial "subscribed" send

      eventHub.broadcast('doc_x', {
        type: 'text_delta',
        sequence: null,
        documentId: 'doc_x',
        conversationId: 'conv_x',
        at: new Date().toISOString(),
        data: { messageId: 'm1', delta: 'dropped while buffered' },
      });
      eventHub.broadcast('doc_x', {
        type: 'agent_started',
        sequence: 1,
        documentId: 'doc_x',
        conversationId: 'conv_x',
        at: new Date().toISOString(),
        data: { turnId: 't1' },
      });

      const parsedSent = sent.slice(1).map((s) => JSON.parse(s) as { type: string }); // drop the "subscribed" frame
      expect(parsedSent.some((f) => f.type === 'text_delta')).toBe(false); // dropped
      expect(parsedSent.some((f) => f.type === 'agent_started')).toBe(true); // persisted frame never dropped

      // Once the buffer drains, ephemeral frames flow again.
      bufferedAmount = 0;
      eventHub.broadcast('doc_x', {
        type: 'text_delta',
        sequence: null,
        documentId: 'doc_x',
        conversationId: 'conv_x',
        at: new Date().toISOString(),
        data: { messageId: 'm1', delta: 'delivered once drained' },
      });
      const afterDrain = sent.slice(1).map((s) => JSON.parse(s) as { type: string });
      expect(afterDrain.some((f) => f.type === 'text_delta')).toBe(true);
    },
  );
});
