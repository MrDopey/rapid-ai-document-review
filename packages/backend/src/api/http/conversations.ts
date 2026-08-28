import type { FastifyInstance } from 'fastify';
import {
  CloseConversationRequest,
  CreateConversationRequest,
  DesignatePrimaryRequest,
  PaginationQuery,
  SendMessageRequest,
} from '@rapid-ai-document-review/shared/contracts/http';
import {
  AgentUnavailableError,
  ConversationClosedError,
  ConversationNotClosedError,
  ConversationNotErroredError,
  ConversationNotFoundError,
  MaxConversationDepthExceededError,
  MaxEditingDepthExceededError,
  PendingEditsBlockCloseError,
  type ConversationService,
} from '../../conversation/conversation-service.js';
import {
  PrimaryConversationClosedError,
  PrimaryConversationErroredError,
  PrimaryConversationNotFoundError,
  PrimaryTargetBusyError,
  type PrimaryService,
} from '../../conversation/primary-service.js';
import type { StorageAdapter } from '../../storage/storage-adapter.js';
import { sendError } from './errors.js';

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: { conversationService: ConversationService; primaryService: PrimaryService; storage: StorageAdapter },
): void {
  const { conversationService, primaryService, storage } = deps;

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

  app.post('/api/conversations', async (request, reply) => {
    const parsed = CreateConversationRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    try {
      const conversation = conversationService.branch(parsed.data);
      return reply.status(201).send(conversation);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      if (err instanceof ConversationClosedError) {
        return sendError(reply, 409, 'CONVERSATION_CLOSED', err.message);
      }
      if (err instanceof MaxConversationDepthExceededError) {
        return sendError(reply, 409, 'MAX_CONVERSATION_DEPTH_EXCEEDED', err.message, {
          limit: err.limit,
          attemptedDepth: err.attemptedDepth,
        });
      }
      throw err;
    }
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

  app.post<{ Params: { id: string } }>('/api/conversations/:id/refresh-send', async (request, reply) => {
    const parsed = SendMessageRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    try {
      const result = await conversationService.refreshAndSend(request.params.id, parsed.data.message);
      return reply.status(202).send(result);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      if (err instanceof ConversationClosedError) {
        return sendError(reply, 409, 'CONVERSATION_CLOSED', err.message);
      }
      if (err instanceof MaxEditingDepthExceededError) {
        return sendError(reply, 409, 'MAX_EDITING_DEPTH_EXCEEDED', err.message, {
          limit: err.limit,
          attemptedDepth: err.attemptedDepth,
        });
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

  app.post<{ Params: { id: string } }>('/api/conversations/:id/close', async (request, reply) => {
    const parsed = CloseConversationRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    try {
      const result = conversationService.close(request.params.id, parsed.data.foldSummaryIntoParent);
      return reply.send(result);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      if (err instanceof PendingEditsBlockCloseError) {
        return sendError(reply, 409, 'PENDING_EDITS_BLOCK_CLOSE', err.message, {
          pendingEditIds: err.pendingEditIds,
        });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/review', async (request, reply) => {
    try {
      const result = conversationService.review(request.params.id);
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      if (err instanceof ConversationNotClosedError) {
        return sendError(reply, 409, 'CONVERSATION_NOT_CLOSED', err.message);
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/primary', async (request, reply) => {
    const parsed = DesignatePrimaryRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    try {
      const result = await primaryService.designate(request.params.id, parsed.data.whenBusy);
      return reply.send(result);
    } catch (err) {
      if (err instanceof PrimaryConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      if (err instanceof PrimaryConversationClosedError) {
        return sendError(reply, 409, 'CONVERSATION_CLOSED', err.message);
      }
      if (err instanceof PrimaryConversationErroredError) {
        return sendError(reply, 409, 'CONVERSATION_ERRORED', err.message);
      }
      if (err instanceof PrimaryTargetBusyError) {
        return sendError(reply, 409, 'PRIMARY_TARGET_BUSY', err.message, err.details);
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id/primary', async (request, reply) => {
    try {
      const result = await primaryService.clear(request.params.id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof PrimaryConversationNotFoundError) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', err.message);
      }
      throw err;
    }
  });
}
