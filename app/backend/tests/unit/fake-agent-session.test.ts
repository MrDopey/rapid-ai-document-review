import { describe, expect, it } from 'vitest';
import {
  FakeAgentSession,
  HANG_DIRECTIVE,
  WEB_SEARCH_DIRECTIVE,
} from '../../src/pi/fake-agent-session.js';
import type { AgentSessionEventLike } from '../../src/pi/agent-session-port.js';
import type { RegisteredToolLike } from '../../src/pi/pi-service.js';

/**
 * FIX 1 (a/b): previously `FakeAgentSession.prompt()` fired `runScript()` via a bare `void` with
 * no `.catch` and no timeout, and only reset `streaming` to `false` once `runScript()` resolved
 * normally. A script that threw unexpectedly or never resolved at all (a stuck tool call) left
 * `streaming` stuck `true` forever — every subsequent `prompt()` call on that session then threw
 * "already streaming" immediately, with no way to recover. These tests exercise `FakeAgentSession`
 * directly (no PiService/HTTP layer) to prove the session itself now always settles.
 */
describe('FakeAgentSession: a hung turn always settles (FIX 1a/1b)', () => {
  function collectEvents(session: FakeAgentSession): AgentSessionEventLike[] {
    const events: AgentSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    return events;
  }

  it('HANG_DIRECTIVE never resolves runScript on its own, but the session force-settles as agent_error after its timeout', async () => {
    const session = new FakeAgentSession(undefined, [], 20);
    const events = collectEvents(session);

    await session.prompt(HANG_DIRECTIVE);
    expect(session.isStreaming).toBe(true);

    await session.waitForIdle();

    expect(session.isStreaming).toBe(false);
    const types = events.map((e) => e.type);
    expect(types).toContain('agent_error');
    expect(types).not.toContain('agent_settled');

    const errorEvent = events.find((e) => e.type === 'agent_error');
    expect(errorEvent && 'message' in errorEvent ? errorEvent.message : '').toMatch(/timed out/i);
  });

  it('a session that just force-settled from a hang accepts a brand-new prompt() immediately (no permanent "already streaming")', async () => {
    const session = new FakeAgentSession(undefined, [], 20);
    await session.prompt(HANG_DIRECTIVE);
    await session.waitForIdle();

    // Previously this would have thrown "already streaming" forever, since `streaming` never
    // reset after the first (hung) turn.
    await expect(session.prompt('hello again')).resolves.toBeUndefined();
    await session.waitForIdle();
    expect(session.isStreaming).toBe(false);
  });

  it('ERROR_DIRECTIVE (a thrown failure, not a hang) also resets streaming and settles as agent_error, never leaving the session stuck', async () => {
    const session = new FakeAgentSession(undefined, [], 5000);
    const events = collectEvents(session);

    await session.prompt('__AGENT_ERROR__' + JSON.stringify({ message: 'boom' }));
    await session.waitForIdle();

    expect(session.isStreaming).toBe(false);
    const errorEvent = events.find((e) => e.type === 'agent_error');
    expect(errorEvent && 'message' in errorEvent ? errorEvent.message : '').toBe('boom');
    expect(events.map((e) => e.type)).not.toContain('agent_settled');

    await expect(session.prompt('fine now')).resolves.toBeUndefined();
  });

  it('a normal plain answer still settles as agent_settled well within the timeout (no false positives)', async () => {
    const session = new FakeAgentSession(undefined, [], 5000);
    const events = collectEvents(session);

    await session.prompt('just chatting');
    await session.waitForIdle();

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_settled');
    expect(types).not.toContain('agent_error');
  });
});

describe('FakeAgentSession: tool_execution_start carries args (009-agent-activity-logging)', () => {
  function collectEvents(session: FakeAgentSession): AgentSessionEventLike[] {
    const events: AgentSessionEventLike[] = [];
    session.subscribe((event) => events.push(event));
    return events;
  }

  it("a simulated web_search call's tool_execution_start event includes the args object passed to it", async () => {
    const webSearchTool: RegisteredToolLike = {
      name: 'web_search',
      execute: async (_toolCallId, params) => ({
        content: [{ type: 'text', text: `Web search: "${(params as { query: string }).query}"` }],
      }),
    };
    const session = new FakeAgentSession(undefined, [webSearchTool], 5000);
    const events = collectEvents(session);

    await session.prompt(WEB_SEARCH_DIRECTIVE + JSON.stringify({ query: 'test query' }));
    await session.waitForIdle();

    const started = events.find((e) => e.type === 'tool_execution_start');
    expect(started && 'args' in started ? started.args : undefined).toEqual({
      query: 'test query',
    });
  });
});
