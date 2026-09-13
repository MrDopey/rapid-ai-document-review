export interface Config {
  port: number;
  host: string;
  databasePath: string;
  piSessionStoragePath: string;
  piCodingAgentDir: string;
  logLevel: string;
  /**
   * Colorized human-readable (`pino-pretty`) log output vs. raw NDJSON. Defaults to whether
   * stdout is an interactive TTY (see `logging.ts`), so piped/production output stays NDJSON
   * without any operator action; `RADR_BE_LOG_PRETTY=1`/`0` forces it either way (e.g. for a
   * dev container whose stdout isn't reported as a TTY).
   */
  logPretty: boolean;
  /** Test-only: use `FakeAgentSession` instead of the real Pi SDK (e2e, no model credential). */
  piFakeSessions: boolean;
  /**
   * Required `provider/model[:thinkingLevel]` override for every newly created agent session
   * (specs/002-pi-agent-model-config). Read raw/unparsed here — actual `provider`/`model`/
   * `thinkingLevel` splitting and `ModelRuntime` resolution happen in `pi/pi-service.ts`
   * (research.md R3), the only module that constructs `ModelRuntime`.
   */
  piAgentModel: string;
  /** SearXNG instance `web_search` queries (specs/008-searxng-web-search). Defaults to the
   *  devcontainer/production-compose service address — override for an externally-provided
   *  SearXNG-compatible instance. */
  searxngUrl: string;
}

/** Reads `name`, trims it, and throws if it is unset, empty, or whitespace-only — for a
 *  mandatory variable with no default. */
function readRequiredTrimmed(name: string): string {
  const trimmed = process.env[name]?.trim();
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return trimmed;
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
 * set `RADR_BE_HOST` to something else (e.g. a containerized dev environment reached via port-forwarding),
 * but the default here MUST stay loopback so a plain `npm run dev`/`npm start` is never silently
 * wide-open; `logging.ts#warnIfHostOverridden` logs a visible warning whenever it is not.
 */
export const DEFAULT_HOST = '127.0.0.1';

const host = readEnv('RADR_BE_HOST', DEFAULT_HOST);

export const config: Config = {
  port: Number(readEnv('RADR_BE_PORT', '3000')),
  host,
  databasePath: readEnv('RADR_BE_DATABASE_PATH', './data/document-review.sqlite'),
  piSessionStoragePath: readEnv('RADR_BE_PI_SESSION_STORAGE_PATH', './data/pi-sessions'),
  piCodingAgentDir: readEnv('RADR_BE_PI_CODING_AGENT_DIR', './data/pi-agent'),
  logLevel: readEnv('RADR_BE_LOG_LEVEL', 'info'),
  logPretty:
    process.env.RADR_BE_LOG_PRETTY === undefined
      ? Boolean(process.stdout.isTTY)
      : process.env.RADR_BE_LOG_PRETTY === '1',
  piFakeSessions: process.env.RADR_BE_PI_FAKE_SESSIONS === '1',
  piAgentModel: readRequiredTrimmed('RADR_BE_PI_AGENT_MODEL'),
  searxngUrl: readEnv('RADR_BE_SEARXNG_URL', 'http://searxng:8080'),
};
