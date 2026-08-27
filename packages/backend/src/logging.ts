import pino from 'pino';
import { config } from './config.js';

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
