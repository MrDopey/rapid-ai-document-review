import { afterEach, describe, expect, it } from 'vitest';
import { HANG_DIRECTIVE } from '../../src/pi/fake-agent-session.js';
import { createTestApp, waitFor } from '../contract/test-app.js';
import type { CreateDocumentResponse } from '@rapid-ai-document-review/shared/contracts/http';

/**
 * FIX 1 end-to-end (real `PiService` + real `FakeAgentSession`, through the HTTP surface exactly
 * as a real client would use it): a stuck tool call/turn must not permanently kill a conversation.
 *
 * Before this fix, `FakeAgentSession.prompt()` fire-and-forgot `runScript()` with no `.catch` and
 * no timeout, so a hang left `streaming` stuck `true` forever; combined with `PiService.sessions`
 * caching one session per conversation for the process's whole lifetime and never evicting on
 * error, every later send/retry on that conversation failed immediately with `502
 * AGENT_UNAVAILABLE "already streaming"` — permanently, with no way to recover.
 */
describe('FIX 1: a hung tool call/turn settles to errored, and the conversation recovers afterward', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("FakeAgentSession's own internal timeout force-settles the turn as errored, and a later retry/send both succeed", async () => {
    process.env.PI_FAKE_TURN_TIMEOUT_MS = '50';
    const { app, storage } = await createTestApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { content: '# Doc\n\nHello.\n' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body) as CreateDocumentResponse;
    const documentId = created.document.id;
    const conversationId = created.mainConversation.id;

    const sendRes = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/conversations/${conversationId}/send`,
      payload: { message: HANG_DIRECTIVE },
    });
    expect(sendRes.statusCode).toBe(202);

    await waitFor(() => storage.getConversation(conversationId)?.status === 'errored', {
      timeoutMs: 3000,
      message: 'expected the hung turn to force-settle to errored via its internal timeout',
    });
    expect(storage.getConversation(conversationId)?.errorMessage).toMatch(/timed out/i);

    // Retrying re-sends the very same (hanging) message. This must not throw "already streaming"
    // or otherwise fail synchronously — the previous (wedged) session was evicted, so a fresh one
    // is built and the retry is accepted normally; it will time out again the same way.
    const retryRes = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/conversations/${conversationId}/retry`,
    });
    expect(retryRes.statusCode).toBe(202);
    await waitFor(() => storage.getConversation(conversationId)?.status === 'working');
    await waitFor(() => storage.getConversation(conversationId)?.status === 'errored', {
      timeoutMs: 3000,
    });

    // Raise the fake session's own turn timeout back up before sending a real (non-hanging)
    // message below — a fresh `FakeAgentSession` is about to be constructed for it (the previous
    // one was evicted), and a plain scripted answer legitimately takes a bit of wall-clock time to
    // stream (several chunked `message_update`s, each with its own small delay); it must not race
    // against the same short timeout the hang tests above rely on.
    process.env.PI_FAKE_TURN_TIMEOUT_MS = '5000';

    // A brand-new, non-hanging message on the very same conversation succeeds normally afterward
    // — proving the conversation is genuinely recoverable, not just capable of erroring again.
    const followUp = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/conversations/${conversationId}/send`,
      payload: { message: 'hello again' },
    });
    expect(followUp.statusCode).toBe(202);
    await waitFor(() => storage.getConversation(conversationId)?.status === 'idle', {
      timeoutMs: 3000,
    });
    expect(storage.getConversation(conversationId)?.errorMessage).toBeNull();
  });

  it("PiService's own turn watchdog force-settles a turn a session's own machinery never resolves, and evicts the session too", async () => {
    // FakeAgentSession's own internal timeout is set far longer than the test would ever wait —
    // only PiService's own watchdog (armed in `send()`) can be the one that fires here.
    process.env.PI_FAKE_TURN_TIMEOUT_MS = '60000';
    process.env.PI_AGENT_TURN_TIMEOUT_MS = '50';
    const { app, storage } = await createTestApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { content: '# Doc\n\nHello.\n' },
    });
    const created = JSON.parse(createRes.body) as CreateDocumentResponse;
    const documentId = created.document.id;
    const conversationId = created.mainConversation.id;

    const sendRes = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/conversations/${conversationId}/send`,
      payload: { message: HANG_DIRECTIVE },
    });
    expect(sendRes.statusCode).toBe(202);

    await waitFor(() => storage.getConversation(conversationId)?.status === 'errored', {
      timeoutMs: 3000,
      message: "expected PiService's own watchdog to force-settle the turn to errored",
    });
    expect(storage.getConversation(conversationId)?.errorMessage).toMatch(/timed out/i);

    // Raise PiService's own watchdog timeout back up before sending a real (non-hanging) message
    // below — a plain scripted answer legitimately takes a bit of wall-clock time to stream and
    // must not race against the same short timeout the hang assertion above relies on.
    process.env.PI_AGENT_TURN_TIMEOUT_MS = '60000';

    const followUp = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/conversations/${conversationId}/send`,
      payload: { message: 'hello again' },
    });
    expect(followUp.statusCode).toBe(202);
    await waitFor(() => storage.getConversation(conversationId)?.status === 'idle', {
      timeoutMs: 3000,
    });
  });
});
