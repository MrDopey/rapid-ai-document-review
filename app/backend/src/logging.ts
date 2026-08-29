import pino from 'pino';
import { config, DEFAULT_HOST } from './config.ts';

/**
 * `event` must always be one of the closed vocabulary values from
 * contracts/websocket-events.md — the same names used for conversation_event.event_type.
 * Never log document content or agent message text at info level or below (FR-042).
 *
 * `config.logPretty` (default: `process.stdout.isTTY`, override via `RADR_BE_LOG_PRETTY=1`/`0`)
 * switches between two destinations:
 *  - pretty: `pino-pretty` colorizes each line by severity (red error, yellow warn, ... ) for an
 *    interactive terminal.
 *  - default (`transport: undefined`): raw NDJSON straight to stdout, unchanged from before —
 *    what production/piped consumers (and log aggregators) expect.
 */
export const logger = pino({
  level: config.logLevel,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: config.logPretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

export type Logger = typeof logger;

/**
 * FR-044: called once at startup (server.ts#main). Loopback is the default and documented
 * access-control model; binding elsewhere is only ever reached via an explicit operator `RADR_BE_HOST`
 * override, never silently. No-op when `config.host` is still the default. No `event` field: a
 * startup binding warning is not one of the closed WebSocket-event-vocabulary values (FR-042) and
 * has no document/conversation context to attach.
 */
export function warnIfHostOverridden(): void {
  if (config.host === DEFAULT_HOST) return;
  logger.warn(
    { host: config.host },
    'binding beyond the loopback interface — this application provides no authentication (FR-044); ' +
      'confirm this was an explicit, intended operator override',
  );
}
