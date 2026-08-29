import pino from 'pino';
import { config, DEFAULT_HOST } from './config.ts';

/**
 * `event` must always be one of the closed vocabulary values from
 * contracts/websocket-events.md — the same names used for conversation_event.event_type.
 * Never log document content or agent message text at info level or below (FR-042).
 */
export const logger = pino({
  level: config.logLevel,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
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
