import { defineConfig, devices } from '@playwright/test';
import { E2E_BACKEND_PORT, E2E_DATABASE_PATH, E2E_PI_SESSION_PATH, E2E_PI_AGENT_DIR } from './tests/e2e/env.js';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node packages/backend/dist/server.js',
      url: `http://127.0.0.1:${E2E_BACKEND_PORT}/healthz`,
      reuseExistingServer: false,
      env: {
        PORT: String(E2E_BACKEND_PORT),
        HOST: '127.0.0.1',
        DATABASE_PATH: E2E_DATABASE_PATH,
        PI_SESSION_STORAGE_PATH: E2E_PI_SESSION_PATH,
        PI_CODING_AGENT_DIR: E2E_PI_AGENT_DIR,
        LOG_LEVEL: 'warn',
        E2E_SEED_REVISION_DEBOUNCE_MS: '2000',
        // No model provider credential is available in this environment (quickstart.md); US2+
        // specs exercise the real send -> PiService -> EventBridge -> WS path against a
        // deterministic, credential-free FakeAgentSession instead of a live Pi session.
        PI_FAKE_SESSIONS: '1',
      },
    },
    {
      command: 'npm run dev --workspace=packages/frontend',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      env: { BACKEND_PORT: String(E2E_BACKEND_PORT) },
    },
  ],
});
