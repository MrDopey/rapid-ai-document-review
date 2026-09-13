import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { convert } from 'html-to-text';
import { webFetchParams } from '@rapid-ai-document-review/shared/contracts/agent-tools';
import { clampWithNote, resolveWebToolTimeoutMs, textResult } from './common.ts';

const WebFetchToolParams = Type.Object({
  url: Type.String({ minLength: 1, description: 'The URL to fetch.' }),
});

export type WebFetchToolDeps = Record<string, never>;

/** Fixed bound on returned page text (FR-012, research.md R4) — not configurable per call or
 *  environment. */
const MAX_CONTENT_CHARS = 20_000;

/**
 * `web_fetch` — fetches a URL and returns its page content as plain text (contracts/web-tools.md).
 * Read-only, available regardless of branch/editing depth. Does not require the URL to have come
 * from a prior `web_search` result — no association is tracked between the two tools.
 */
export function createWebFetchTool(_deps: WebFetchToolDeps) {
  return defineTool({
    name: 'web_fetch',
    label: 'Web fetch',
    description:
      'Fetch a URL and return its page content as plain text.' +
      'Cite the URL directly in your visible response if you rely on its content.',
    promptSnippet: 'web_fetch(url) — fetch a web page as plain text',
    parameters: WebFetchToolParams,
    execute: async (_toolCallId, rawParams) => {
      const params = webFetchParams.parse(rawParams);
      const url = params.url;

      const timeoutMs = resolveWebToolTimeoutMs();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          return textResult(`Could not fetch ${url}: server responded with status ${res.status}.`);
        }

        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.startsWith('text/')) {
          return textResult(
            `Could not fetch ${url}: response content type "${contentType || 'unknown'}" is not text.`,
          );
        }

        const body = await res.text();
        const text = contentType.includes('html') ? convert(body) : body;

        const clamp = clampWithNote(text.length, 0, MAX_CONTENT_CHARS, 'content length');
        const truncated = text.slice(0, clamp.value);
        const noteSuffix = clamp.note ? `\n\n(${clamp.note})` : '';

        return textResult(`Fetched: ${url}\n\n${truncated}${noteSuffix}`);
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const message = isTimeout
          ? `timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
        return textResult(`Could not fetch ${url}: request failed (${message}).`);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
