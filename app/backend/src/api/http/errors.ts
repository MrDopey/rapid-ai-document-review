import type { FastifyReply } from 'fastify';
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
