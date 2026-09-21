import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebFetchTool } from '../../src/pi/tools/web-fetch.js';

/**
 * Unit tests for `web_fetch` (specs/008-searxng-web-search, contracts/web-tools.md, research.md
 * R3/R4/R5) — `pi/tools/web-fetch.ts` does not exist yet at the time this file is authored, so
 * every test below is expected to be RED (module resolution failure) until that implementation
 * lands, mirroring `tests/contract/pi-model-config.test.ts`'s top comment.
 *
 * Driven by calling `.execute(toolCallId, rawParams)` directly on the tool object against a local
 * HTTP stub standing in for a fetched page — no live internet access (research.md R5).
 */

type ToolResult = { content: { type: string; text: string }[]; details?: unknown };

function startStub(
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

describe('web_fetch tool (unit)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('extracts readable plain text from an HTML page, with no raw tags (contract #5)', async () => {
    const html =
      '<html><head><title>Stub Page</title></head><body>' +
      '<h1>Stub Page Heading</h1>' +
      '<p>This is the recognizable paragraph content the test looks for.</p>' +
      '</body></html>';
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server = stub.server;

    const tool = createWebFetchTool({ checkUrlIsBlocked: async () => null });
    const outcome = (await tool.execute('test-tool-call-1', {
      url: `${stub.url}/page`,
    })) as ToolResult;
    const text = outcome.content[0]?.text ?? '';

    expect(text).toContain('This is the recognizable paragraph content the test looks for.');
    expect(text).not.toContain('<html>');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('<body>');
  });

  it('truncates a page larger than the size bound, with a truncation note appended (contract #6)', async () => {
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
    const bigBody = paragraph.repeat(500); // ~29,000 chars — comfortably past the ~20,000 bound.
    const html = `<html><body><p>${bigBody}</p></body></html>`;
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server = stub.server;

    const tool = createWebFetchTool({ checkUrlIsBlocked: async () => null });
    const outcome = (await tool.execute('test-tool-call-1', {
      url: `${stub.url}/big`,
    })) as ToolResult;
    const text = outcome.content[0]?.text ?? '';

    expect(text.length).toBeLessThan(bigBody.length);
    expect(text.length).toBeLessThan(21000);
    // The exact wording of the truncation note is model-facing prose, not a versioned contract
    // (contracts/web-tools.md) — only that some explanatory note about the cut is present.
    expect(text.toLowerCase()).toMatch(/truncat|clamp/);
  });

  it('returns an explanatory error for a non-textual content type, not the binary content (contract #7)', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(binary);
    });
    server = stub.server;

    const tool = createWebFetchTool({ checkUrlIsBlocked: async () => null });
    const outcome = (await tool.execute('test-tool-call-1', {
      url: `${stub.url}/image.png`,
    })) as ToolResult;
    const text = outcome.content[0]?.text ?? '';

    expect(text.toLowerCase()).toMatch(/could not|cannot|unable|not text|binary|unsupported|error/);
    expect(text).not.toContain(binary.toString('binary'));
  });

  it('rejects with an explanatory message for an unreachable backend (contract #8)', async () => {
    const stub = await startStub(() => {});
    const unreachableUrl = stub.url;
    await closeServer(stub.server);
    server = undefined;

    const tool = createWebFetchTool({ checkUrlIsBlocked: async () => null });

    // A genuine network failure now rejects (so the Pi SDK's isError/failureReason path fires)
    // rather than resolving with a graceful textResult — see web-fetch.ts's catch block.
    await expect(
      tool.execute('test-tool-call-1', { url: `${unreachableUrl}/page` }),
    ).rejects.toThrow(/could not fetch|request failed/i);
  });

  it('blocks a loopback/private-address URL by default, without needing a test override (SSRF guard)', async () => {
    const tool = createWebFetchTool({});
    const outcome = (await tool.execute('test-tool-call-1', {
      url: 'http://127.0.0.1:1/',
    })) as ToolResult;
    const text = outcome.content[0]?.text ?? '';

    expect(text.toLowerCase()).toMatch(/blocked|private address/);
  });
});
