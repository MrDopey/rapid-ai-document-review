import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { webSearchParams } from '@rapid-ai-document-review/shared/contracts/agent-tools';
import { resolveWebToolTimeoutMs, textResult } from './common.ts';

const WebSearchToolParams = Type.Object({
  query: Type.String({ minLength: 1, description: 'The search query.' }),
});

export interface WebSearchToolDeps {
  searxngUrl: string;
}

interface SearxngResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

/** SearXNG's own JSON API caps top results returned to the agent (research.md R4) — not
 *  configurable per call or environment. */
const MAX_RESULTS = 8;

function renderSearchResult(
  query: string,
  results: { title: string; url: string; snippet: string }[],
): string {
  if (results.length === 0) {
    return `Web search: "${query}"\nNo results found.`;
  }
  const items = results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`);
  return [`Web search: "${query}"`, `${results.length} results`, '', ...items].join('\n');
}

/**
 * `web_search` — searches the web via a self-hosted SearXNG instance and returns a bounded list
 * of results (contracts/web-tools.md). Read-only, available regardless of branch/editing depth.
 */
export function createWebSearchTool(deps: WebSearchToolDeps) {
  return defineTool({
    name: 'web_search',
    label: 'Web search',
    description:
      'Search the web and return a bounded list of results (title, URL, snippet).' +
      'cite the URLs of any results you rely on directly in your response.',
    promptSnippet: 'web_search(query) — search the web',
    parameters: WebSearchToolParams,
    execute: async (_toolCallId, rawParams) => {
      const params = webSearchParams.parse(rawParams);
      const query = params.query.trim();
      if (!query) {
        return textResult('A search query is required.');
      }

      const timeoutMs = resolveWebToolTimeoutMs();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `${deps.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`;
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          return textResult(
            `Web search failed: search backend responded with status ${res.status}.`,
          );
        }
        const body = (await res.json()) as { results?: SearxngResult[] };
        const results = (body.results ?? []).slice(0, MAX_RESULTS).map((r) => ({
          title: String(r.title ?? ''),
          url: String(r.url ?? ''),
          snippet: String(r.content ?? ''),
        }));
        return textResult(renderSearchResult(query, results));
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const message = isTimeout
          ? `could not reach the search backend (timed out after ${timeoutMs}ms)`
          : `could not reach the search backend (${err instanceof Error ? err.message : String(err)})`;
        // Thrown, not returned as a `textResult`: a genuine network/timeout failure must surface
        // through the Pi SDK's own `isError`/`failureReason` tool-result path (spec 009, Agent
        // Activity Logging) rather than being logged as an ordinary successful tool call — see
        // `web-fetch.ts`'s matching catch block for why throwing here is safe (caught by the SDK's
        // own `executePreparedToolCall`, not an unhandled crash of the agent turn).
        throw new Error(`Web search failed: ${message}.`);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
