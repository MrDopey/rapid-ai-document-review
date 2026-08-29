import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { StorageAdapter } from '../../src/storage/storage-adapter.js';

export interface TestApp {
  app: FastifyInstance;
  storage: StorageAdapter;
}

/**
 * Builds a fresh, fully-isolated backend instance for black-box contract testing
 * (app/backend/tests/contract/{http,ws}.test.ts): an in-memory SQLite database — a brand-new
 * `:memory:` connection every call, per `node:sqlite`, never shared across instances — and
 * `RADR_BE_PI_FAKE_SESSIONS=1` so agent turns run through the deterministic `FakeAgentSession`
 * (src/pi/fake-agent-session.ts) instead of requiring a live model credential (mirrors
 * playwright.config.ts's e2e setup, quickstart.md).
 *
 * Environment variables are set before a *dynamic* import of `server.ts` deliberately: a static
 * top-level `import` would resolve `config.ts` (which reads `process.env` exactly once, at module
 * evaluation time) before this function's own body ever runs, since ES module imports are
 * evaluated before the importing module's top-level statements. `import()` is cached by Node after
 * its first resolution, so calling this repeatedly is cheap — every call just re-invokes the
 * already-loaded `buildApp`, which constructs an entirely fresh service graph each time.
 */
export async function createTestApp(): Promise<TestApp> {
  process.env.RADR_BE_DATABASE_PATH = ':memory:';
  process.env.RADR_BE_PI_FAKE_SESSIONS = '1';
  process.env.RADR_BE_HOST ??= '127.0.0.1';
  process.env.RADR_BE_LOG_LEVEL ??= 'silent';
  process.env.RADR_BE_PI_SESSION_STORAGE_PATH ??= './data/contract-test-pi-sessions';
  process.env.RADR_BE_PI_CODING_AGENT_DIR ??= './data/contract-test-pi-agent';
  process.env.RADR_BE_PI_AGENT_MODEL ??= 'anthropic/claude-opus-4-5';
  const { buildApp } = await import('../../src/server.js');
  return buildApp();
}

/** Starts `app` listening on an ephemeral loopback port and returns its `ws://` base URL, for
 *  tests that need a real socket (WebSocket upgrades cannot be exercised through `app.inject()`). */
export async function listenForWs(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('createTestApp: failed to determine the listening port');
  }
  return `ws://127.0.0.1:${address.port}`;
}

/** Polls `predicate` until it returns true, or throws after `timeoutMs` — used throughout these
 *  contract tests to await the effects of a `FakeAgentSession` turn, which always settles
 *  asynchronously (fire-and-forget timers), never within the HTTP call that kicked it off
 *  (http-api.md's "long-running operations" convention). */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const intervalMs = opts.intervalMs ?? 10;
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(opts.message ?? 'waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
