import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SubscribedFrame } from '@rapid-ai-document-review/shared/contracts/events';
import { createTestApp, listenForWs, waitFor } from '../contract/test-app.js';

/**
 * Proves FR-006/SC-003 at the WebSocket transport layer (US2, T028-T029): a document's event
 * stream never leaks onto another document's subscription while an agent response is actively
 * streaming, and a client that disconnects mid-stream and later reconnects with the sequence
 * number it last saw is caught up on everything it missed, via `EventHub.subscribe`'s
 * `sinceSequence` replay (`app/backend/src/events/event-hub.ts:96-108`) — not merely via the
 * frontend re-fetching a fresh snapshot.
 */

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

async function openSocket(
  baseUrl: string,
  documentId: string,
  sinceSequence: number | null,
): Promise<{ ws: WebSocket; frames: Frame[]; subscribed: SubscribedFrame }> {
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
  const subscribed = SubscribedFrame.parse(frames.find((f) => f.type === 'subscribed'));
  return { ws, frames, subscribed };
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

async function createDoc(app: FastifyInstance, content: string) {
  const res = await call(app, 'POST', '/api/documents', { content });
  expect(res.status).toBe(201);
  return res.json as { document: { id: string }; mainConversation: { id: string } };
}

async function setup() {
  const { app, storage } = await createTestApp();
  const baseUrl = await listenForWs(app);
  return { app, storage, baseUrl };
}

const LONG_MESSAGE_PARAGRAPH =
  'Sentence one about the quarterly roadmap. Sentence two about the migration plan. ' +
  'Sentence three about the review cadence. Sentence four about the rollout window. ' +
  'Sentence five about the rollback plan. Sentence six wraps up the summary nicely.';

describe('Multi-document WebSocket isolation (US2, T028-T029)', () => {
  const previousChunkDelay = process.env.RADR_BE_TEST_FAKE_CHUNK_DELAY_MS;

  beforeEach(() => {
    // A real inter-chunk delay is needed so a concurrently-subscribed socket has a window in which
    // to observe (or fail to observe) in-flight deltas before the turn settles — env-defaults.ts
    // collapses this to 0 for the rest of the suite.
    process.env.RADR_BE_TEST_FAKE_CHUNK_DELAY_MS = '15';
  });

  afterEach(() => {
    if (previousChunkDelay === undefined) delete process.env.RADR_BE_TEST_FAKE_CHUNK_DELAY_MS;
    else process.env.RADR_BE_TEST_FAKE_CHUNK_DELAY_MS = previousChunkDelay;
  });

  // Longer than the suite default (5000ms): depends on real inter-chunk delays
  // (RADR_BE_TEST_FAKE_CHUNK_DELAY_MS) and polling windows, which need slack under CPU contention.
  it('T028: zero Document-A-scoped events are ever delivered on Document B’s subscription while A streams', async () => {
    const { app, storage, baseUrl } = await setup();
    const docA = await createDoc(app, 'Document A content.');
    const docB = await createDoc(app, 'Document B content.');

    const { ws: wsB, frames: framesB } = await openSocket(baseUrl, docB.document.id, null);
    try {
      await call(
        app,
        'POST',
        `/api/documents/${docA.document.id}/conversations/${docA.mainConversation.id}/send`,
        {
          message: LONG_MESSAGE_PARAGRAPH,
        },
      );

      // Poll repeatedly while A's turn is still in flight, then again after it settles — B must
      // never see a frame carrying A's documentId at any point.
      for (let i = 0; i < 10; i++) {
        expect(framesB.some((f) => f.documentId === docA.document.id)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await waitFor(() => storage.getConversation(docA.mainConversation.id)?.status === 'idle');
      expect(framesB.some((f) => f.documentId === docA.document.id)).toBe(false);

      // Sanity check the harness actually produced streaming frames worth isolating against.
      const aEventsPersisted = storage.listEventsSince(docA.document.id, 0);
      expect(aEventsPersisted.some((e) => e.eventType === 'message_completed')).toBe(true);

      // Every content frame B did receive must be genuinely its own (the initial "subscribed"
      // handshake frame carries no documentId field at all, so it's excluded here).
      for (const frame of framesB) {
        if (frame.type === 'subscribed') continue;
        expect(frame.documentId).toBe(docB.document.id);
      }
    } finally {
      await closeSocket(wsB);
    }
  }, 15000);

  // Longer than the suite default (5000ms): depends on the same real inter-chunk delay as T028.
  it('T029: reconnecting with a tracked sinceSequence after switching away mid-stream replays the full completed response with nothing missing', async () => {
    const { app, storage, baseUrl } = await setup();
    const docA = await createDoc(app, 'Document A content for catch-up test.');

    const { ws: firstSocket, subscribed: initialSubscribed } = await openSocket(
      baseUrl,
      docA.document.id,
      null,
    );
    const seqBeforeSwitch = initialSubscribed.currentSequence;

    await call(
      app,
      'POST',
      `/api/documents/${docA.document.id}/conversations/${docA.mainConversation.id}/send`,
      {
        message: LONG_MESSAGE_PARAGRAPH,
      },
    );

    // Give the turn a moment to start streaming, then simulate "switching away" by disconnecting
    // entirely (mirrors the frontend closing/re-pointing its single WS connection).
    await new Promise((resolve) => setTimeout(resolve, 30));
    await closeSocket(firstSocket);

    await waitFor(() => storage.getConversation(docA.mainConversation.id)?.status === 'idle');

    const { frames: catchUpFrames, subscribed: catchUpSubscribed } = await openSocket(
      baseUrl,
      docA.document.id,
      seqBeforeSwitch,
    );

    expect(catchUpSubscribed.replayCount).toBeGreaterThan(0);

    const replayedSequences = catchUpFrames
      .filter((f) => f.type !== 'subscribed' && f.sequence !== null)
      .map((f) => f.sequence as number)
      .sort((a, b) => a - b);

    // Nothing missing: every sequence number from just after the disconnect point up to the
    // latest known sequence must appear exactly once in the replay.
    const expectedSequences: number[] = [];
    for (let seq = seqBeforeSwitch + 1; seq <= catchUpSubscribed.currentSequence; seq++) {
      expectedSequences.push(seq);
    }
    expect(replayedSequences).toEqual(expectedSequences);

    const messageEndFrame = catchUpFrames.find((f) => f.type === 'message_completed');
    expect(messageEndFrame).toBeDefined();
    const data = messageEndFrame!.data as { text: string };
    expect(data.text.length).toBeGreaterThan(0);

    // Cross-check against storage directly: the persisted log agrees with what was replayed.
    const persisted = storage.listEventsSince(docA.document.id, seqBeforeSwitch);
    expect(persisted.map((r) => r.sequence)).toEqual(expectedSequences);
  }, 15000);
});
