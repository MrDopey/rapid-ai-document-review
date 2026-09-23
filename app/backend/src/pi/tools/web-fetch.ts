import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { convert } from 'html-to-text';
import { webFetchParams } from '@rapid-ai-document-review/shared/contracts/agent-tools';
import { clampWithNote, resolveWebToolTimeoutMs, textResult } from './common.ts';

const WebFetchToolParams = Type.Object({
  url: Type.String({ minLength: 1, description: 'The URL to fetch.' }),
});

export type WebFetchToolDeps = {
  /** Test-only hook to bypass the SSRF guard below for a local test stub server. Production
   *  callers must always omit this (or pass `{}`) so the real guard applies. */
  checkUrlIsBlocked?: (url: string) => Promise<string | null>;
};

/** Fixed bound on returned page text (FR-012, research.md R4) — not configurable per call or
 *  environment. */
const MAX_CONTENT_CHARS = 20_000;

/**
 * SSRF guard (contracts/web-tools.md): a model-supplied `url` is fetched with no other
 * authentication/authorization boundary around it, so this tool must never be usable to reach
 * loopback/private/link-local network space (including the cloud metadata address
 * `169.254.169.254`) that a legitimate public "fetch a web page" request would never target.
 * Only `http:`/`https:` schemes are allowed at all — anything else (`file:`, `gopher:`, etc.) is
 * rejected before any network access is attempted.
 */
const BLOCKED_IPV4_RANGES: [string, number][] = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

/** IPv6 loopback (`::1`), unique-local (`fc00::/7`) and link-local (`fe80::/10`) — the IPv6
 *  counterparts of the IPv4 ranges above. Compares against the fully expanded (non-shorthand)
 *  form Node's `dns.lookup` always returns for a resolved IPv6 address, so no `::`-expansion is
 *  needed here. */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  const firstGroup = lower.split(':')[0] ?? '';
  const firstByte = Number.parseInt(firstGroup.padStart(4, '0').slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return false;
  // fc00::/7 => first byte 0xfc or 0xfd; fe80::/10 => first 10 bits 1111111010, i.e. first byte
  // 0xfe and the top 2 bits of the second byte equal to 0b10 (0x80-0xbf).
  if (firstByte === 0xfc || firstByte === 0xfd) return true;
  if (firstByte === 0xfe) {
    const secondByte = Number.parseInt(firstGroup.padStart(4, '0').slice(2, 4), 16);
    if (!Number.isNaN(secondByte) && secondByte >= 0x80 && secondByte <= 0xbf) return true;
  }
  return false;
}

function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return false;
}

/**
 * Rejects a `web_fetch` URL before any network access: disallowed scheme, or a hostname that
 * resolves (via `dns.lookup`) to a blocked private/loopback/link-local address. Returns an
 * explanatory reason string when the URL should be blocked, or `null` when it's safe to fetch.
 */
async function checkUrlIsBlocked(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'the URL could not be parsed';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `scheme "${parsed.protocol}" is not allowed (only http/https)`;
  }

  const hostname = parsed.hostname;
  // A literal IP in the URL itself (no DNS involved) is checked directly.
  if (isIP(hostname)) {
    return isBlockedIpAddress(hostname)
      ? `resolves to a blocked private address (${hostname})`
      : null;
  }

  try {
    const { address } = await dnsLookup(hostname);
    return isBlockedIpAddress(address)
      ? `resolves to a blocked private address (${address})`
      : null;
  } catch (err) {
    return `hostname could not be resolved (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * `web_fetch` — fetches a URL and returns its page content as plain text (contracts/web-tools.md).
 * Read-only, available regardless of branch/editing depth. Does not require the URL to have come
 * from a prior `web_search` result — no association is tracked between the two tools.
 */
export function createWebFetchTool(deps: WebFetchToolDeps) {
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

      const blockedReason = await (deps.checkUrlIsBlocked ?? checkUrlIsBlocked)(url);
      if (blockedReason) {
        // Graceful text-failure result (same pattern as every other fetch failure below), not a
        // thrown error — an SSRF-blocked target is a normal, expected outcome for a model-supplied
        // URL, not the network/timeout failure category `catch` below flags as a genuine tool error.
        return textResult(`Could not fetch ${url}: request blocked (${blockedReason}).`);
      }

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
        // Thrown, not returned as a `textResult`: a genuine network/timeout failure must surface
        // through the Pi SDK's own `isError`/`failureReason` tool-result path (spec 009, Agent
        // Activity Logging) rather than being logged as an ordinary successful tool call. The SDK's
        // own `executePreparedToolCall` already awaits this `execute()` inside a try/catch, so
        // throwing here rejects cleanly into that existing error-result path — it does not crash
        // the agent turn.
        throw new Error(`Could not fetch ${url}: request failed (${message}).`, { cause: err });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
