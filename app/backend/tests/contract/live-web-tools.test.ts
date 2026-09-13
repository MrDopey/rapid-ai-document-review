import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { createWebFetchTool, createWebSearchTool } from '../../src/pi/tools/index.js';

/**
 * specs/008-searxng-web-search research.md R5 — opt-in live counterpart to the stub-backed unit
 * tests (tests/unit/web-search-tool.test.ts, tests/unit/web-fetch-tool.test.ts). Those prove the
 * tools' own request/response handling in isolation; this proves the tools actually work against a
 * real SearXNG instance and the real internet, the way `live-pi.test.ts` proves the real Pi SDK
 * still emits what the event bridge depends on. Gated on `RADR_BE_SEARXNG_LIVE_TEST=1` and skipped
 * entirely otherwise — requires a reachable SearXNG instance (e.g. the devcontainer's `searxng`
 * service) and outbound internet access, neither of which the default `npm run test:*` scripts can
 * assume. Excluded from `test:contract` (package.json) the same way `live-pi.test.ts` is; run via
 * `npm run test:contract:live`.
 */
const LIVE = process.env.RADR_BE_SEARXNG_LIVE_TEST === '1';

// tests/setup/env-defaults.ts forces WEB_TOOL_TIMEOUT_MS=200 (via `??=`) for the fast stub-backed
// unit suite; a real network round-trip needs more than that, so this opt-in suite raises it back
// up for itself specifically.
if (LIVE) process.env.WEB_TOOL_TIMEOUT_MS = '10000';

describe.skipIf(!LIVE)('Contract: live web tools (contracts/web-tools.md, opt-in)', () => {
  it('web_search returns real results from the configured SearXNG instance', async () => {
    const tool = createWebSearchTool({ searxngUrl: config.searxngUrl });
    const result = (await (
      tool as unknown as {
        execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
      }
    ).execute('live_search', { query: 'searxng' })) as { content: { text: string }[] };

    const text = result.content[0]!.text;
    expect(text).toContain('Web search: "searxng"');
    expect(text).not.toContain('Web search failed');
    expect(text).not.toContain('No results found.');
  }, 30_000);

  it('web_fetch retrieves and extracts real page content', async () => {
    const tool = createWebFetchTool({});
    const result = (await (
      tool as unknown as {
        execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
      }
    ).execute('live_fetch', { url: 'http://example.com/' })) as { content: { text: string }[] };

    const text = result.content[0]!.text;
    expect(text).toContain('Fetched: http://example.com/');
    expect(text.toLowerCase()).toContain('example domain');
    expect(text).not.toContain('Could not fetch');
  }, 30_000);

  it('web_search reports an explanatory error against an unreachable backend, not a crash', async () => {
    const tool = createWebSearchTool({ searxngUrl: 'http://127.0.0.1:1' });
    const result = (await (
      tool as unknown as {
        execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
      }
    ).execute('live_search_unreachable', { query: 'test' })) as { content: { text: string }[] };

    expect(result.content[0]!.text).toContain('Web search failed');
  }, 30_000);
});
