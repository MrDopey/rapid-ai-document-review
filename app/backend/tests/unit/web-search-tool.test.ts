import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebSearchTool } from '../../src/pi/tools/web-search.js';

/**
 * Unit tests for `web_search` (specs/008-searxng-web-search, contracts/web-tools.md, research.md
 * R5) — `pi/tools/web-search.ts` does not exist yet at the time this file is authored, so every
 * test below is expected to be RED (module resolution failure) until that implementation lands,
 * mirroring `tests/contract/pi-model-config.test.ts`'s top comment.
 *
 * Driven by calling `.execute(toolCallId, rawParams)` directly on the tool object against a local
 * HTTP stub standing in for SearXNG's `?format=json` endpoint — no live SearXNG instance, no
 * `FakeAgentSession` directive scripting (research.md R5).
 */

type ToolResult = { content: { type: string; text: string }[]; details?: unknown };

function searxngJsonBody(results: { title: string; url: string; content: string }[]): string {
  return JSON.stringify({ query: 'stub query', results });
}

function startJsonStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('web_search tool (unit)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('returns exactly the stub-provided results, each with title/url/snippet (contract #1)', async () => {
    const results = [
      {
        title: 'SearXNG JSON API',
        url: 'https://docs.searxng.org/dev/search_api.html',
        content: 'Describes format=json.',
      },
      { title: 'Second result', url: 'https://example.com/2', content: 'Second snippet text.' },
      { title: 'Third result', url: 'https://example.com/3', content: 'Third snippet text.' },
    ];
    const stub = await startJsonStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(searxngJsonBody(results));
    });
    server = stub.server;

    const tool = createWebSearchTool({ searxngUrl: stub.url });
    const outcome = (await tool.execute('test-tool-call-1', {
      query: 'searxng json api format',
    })) as ToolResult;
    const text = outcome.content[0]?.text ?? '';

    for (const r of results) {
      expect(text).toContain(r.title);
      expect(text).toContain(r.url);
      expect(text).toContain(r.content);
    }
    expect(text.toLowerCase()).not.toContain('no results');
  });

  it('returns plain "no results" text, not an error, for a zero-result response (contract #2)', async () => {
    const stub = await startJsonStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(searxngJsonBody([]));
    });
    server = stub.server;

    const tool = createWebSearchTool({ searxngUrl: stub.url });
    const outcome = (await tool.execute('test-tool-call-1', {
      query: 'asdkjfhaslkdjfhoiuweqr',
    })) as ToolResult;
    const text = outcome.content[0]?.text ?? '';

    expect(text.toLowerCase()).toContain('no results');
    expect(text.toLowerCase()).not.toContain('error');
    expect(text.toLowerCase()).not.toContain('failed');
  });

  it('rejects with an explanatory message for an unreachable backend, bounded by RADR_BE_TEST_WEB_TOOL_TIMEOUT_MS (contract #3)', async () => {
    // Bind to get a free ephemeral port, then close immediately: the most deterministic way to
    // guarantee "nothing is listening here" without racing another process for a fixed port.
    const stub = await startJsonStub(() => {});
    const unreachableUrl = stub.url;
    await closeServer(stub.server);
    server = undefined;

    const tool = createWebSearchTool({ searxngUrl: unreachableUrl });

    // A genuine network failure now rejects (so the Pi SDK's isError/failureReason path fires)
    // rather than resolving with a graceful textResult — see web-search.ts's catch block.
    await expect(tool.execute('test-tool-call-1', { query: 'anything' })).rejects.toThrow(
      /fail|error|could not|unreachable|timed? ?out/i,
    );
  });

  it('returns an explanatory result without ever calling the backend for a blank/whitespace-only query (contract #4)', async () => {
    let hit = false;
    const stub = await startJsonStub((_req, res) => {
      hit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        searxngJsonBody([
          { title: 'Should never be seen', url: 'https://example.com/unseen', content: 'x' },
        ]),
      );
    });
    server = stub.server;

    const tool = createWebSearchTool({ searxngUrl: stub.url });
    const outcome = (await tool.execute('test-tool-call-1', { query: '   ' })) as ToolResult;
    const text = outcome.content[0]?.text ?? '';

    expect(hit).toBe(false);
    expect(text).not.toContain('Should never be seen');
    expect(text.length).toBeGreaterThan(0);
  });
});
