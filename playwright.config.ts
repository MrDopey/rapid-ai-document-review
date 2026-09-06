import { defineConfig, devices } from '@playwright/test';
import {
  E2E_BACKEND_PORT,
  E2E_DATABASE_PATH,
  E2E_PI_SESSION_PATH,
  E2E_PI_AGENT_DIR,
} from './tests/e2e/env.js';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:3001',
    trace: 'retain-on-failure',
  },
  // All specs share one backend/database for the whole run (see env.ts). us1's "no document
  // yet" scenario must run before any other spec creates a document, so the story specs
  // (us1-us8+, in that file order) are a separate project that the a11y project depends on —
  // Playwright runs a dependency project to completion before the dependent project starts.
  projects: [
    { name: 'stories', testMatch: /us\d+\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'a11y',
      testMatch: /a11y\.spec\.ts/,
      dependencies: ['stories'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'history-diff',
      // Self-contained spec (creates its own document) — depends on 'stories' only so it runs
      // after us1's "no document yet" scenario, not because it shares any fixture with it.
      testMatch: /history-diff\.spec\.ts/,
      dependencies: ['stories'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node app/backend/dist/server.js',
      url: `http://127.0.0.1:${E2E_BACKEND_PORT}/healthz`,
      reuseExistingServer: false,
      env: {
        RADR_BE_PORT: String(E2E_BACKEND_PORT),
        RADR_BE_HOST: '127.0.0.1',
        RADR_BE_DATABASE_PATH: E2E_DATABASE_PATH,
        RADR_BE_PI_SESSION_STORAGE_PATH: E2E_PI_SESSION_PATH,
        RADR_BE_PI_CODING_AGENT_DIR: E2E_PI_AGENT_DIR,
        RADR_BE_PI_AGENT_MODEL: 'anthropic/claude-opus-4-5',
        RADR_BE_LOG_LEVEL: 'warn',
        RADR_BE_E2E_SEED_REVISION_DEBOUNCE_MS: '2000',
        // No model provider credential is available in this environment (quickstart.md); US2+
        // specs exercise the real send -> PiService -> EventBridge -> WS path against a
        // deterministic, credential-free FakeAgentSession instead of a live Pi session.
        RADR_BE_PI_FAKE_SESSIONS: '1',
      },
    },
    {
      command: 'npm run dev --workspace=app/frontend',
      url: 'http://127.0.0.1:3001',
      reuseExistingServer: false,
      env: { RADR_FE_BACKEND_PORT: String(E2E_BACKEND_PORT) },
    },
  ],
});
