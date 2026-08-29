export interface Config {
  port: number;
  host: string;
  databasePath: string;
  piSessionStoragePath: string;
  piCodingAgentDir: string;
  logLevel: string;
  /** Test-only: use `FakeAgentSession` instead of the real Pi SDK (e2e, no model credential). */
  piFakeSessions: boolean;
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * FR-044: loopback is the default and documented access-control model. An operator MAY explicitly
 * set `HOST` to something else (e.g. a containerized dev environment reached via port-forwarding),
 * but the default here MUST stay loopback so a plain `npm run dev`/`npm start` is never silently
 * wide-open; `logging.ts#warnIfHostOverridden` logs a visible warning whenever it is not.
 */
export const DEFAULT_HOST = '127.0.0.1';

const host = readEnv('HOST', DEFAULT_HOST);

export const config: Config = {
  port: Number(readEnv('PORT', '3000')),
  host,
  databasePath: readEnv('DATABASE_PATH', './data/document-review.sqlite'),
  piSessionStoragePath: readEnv('PI_SESSION_STORAGE_PATH', './data/pi-sessions'),
  piCodingAgentDir: readEnv('PI_CODING_AGENT_DIR', './data/pi-agent'),
  logLevel: readEnv('LOG_LEVEL', 'info'),
  piFakeSessions: process.env.PI_FAKE_SESSIONS === '1',
};
