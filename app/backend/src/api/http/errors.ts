import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { ErrorCode } from '@rapid-ai-document-review/shared/contracts/http';

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): void {
  reply.status(status).send({ error: { code, message: message.slice(0, 500), details } });
}

/**
 * Shared `schema.safeParse(input)` + 400 VALIDATION_FAILED boilerplate, repeated across every route
 * file that validates a request body/query against a Zod schema. Caller pattern:
 *   const data = parseOrFail(reply, Schema, request.body);
 *   if (!data) return;
 * On failure this already sent the (byte-identical) error response; the caller just needs to stop.
 */
export function parseOrFail<T>(reply: FastifyReply, schema: z.ZodType<T>, input: unknown): T | undefined {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    return undefined;
  }
  return parsed.data;
}
