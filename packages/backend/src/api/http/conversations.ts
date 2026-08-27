import type { FastifyInstance } from 'fastify';
import { PaginationQuery, SendMessageRequest } from '@rapid-ai-document-review/shared/contracts/http';
import {
  AgentUnavailableError,
  ConversationClosedError,
  ConversationNotErroredError,
  ConversationNotFoundError,
  type ConversationService,
} from '../../conversation/conversation-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { sendError } from './errors.js';

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: { conversationService: ConversationService; storage: StorageAdapter },
): void {
  const { conversationService, storage } = deps;

  app.get('/api/conversations', async (request, reply) => {
    const doc = storage.getDocument();
    if (!doc) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'No document has been created yet');
    }
    const parsed = PaginationQuery.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    return reply.send(conversationService.getAll(doc.id, parsed.data));
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    try {
      return reply.send(conversationService.getOne(request.params.id));
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/send', async (request, reply) => {
    const parsed = SendMessageRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    try {
      const result = await conversationService.send(request.params.id, parsed.data.message);
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      if (err instanceof ConversationClosedError) {
        return sendError(reply, 409, 'CONVERSATION_CLOSED', err.message);
      }
      if (err instanceof AgentUnavailableError) {
        return sendError(reply, 502, 'AGENT_UNAVAILABLE', err.message);
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/retry', async (request, reply) => {
    try {
      const result = await conversationService.retry(request.params.id);
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      if (err instanceof ConversationNotErroredError) {
        return sendError(reply, 409, 'CONVERSATION_NOT_ERRORED', err.message);
      }
      if (err instanceof AgentUnavailableError) {
        return sendError(reply, 502, 'AGENT_UNAVAILABLE', err.message);
      }
      throw err;
    }
  });
}
