import { mkdirSync } from 'node:fs';
import { E2E_PI_SESSION_PATH, E2E_PI_AGENT_DIR } from './env.js';

async function globalSetup(): Promise<void> {
  // DATABASE_PATH's parent dir is created by the backend itself on startup (server.ts); these
  // two are read directly by the Pi SDK path options once wired up, so ensure they pre-exist too.
  mkdirSync(E2E_PI_SESSION_PATH, { recursive: true });
  mkdirSync(E2E_PI_AGENT_DIR, { recursive: true });
}

export default globalSetup;
