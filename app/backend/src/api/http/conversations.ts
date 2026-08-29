import type { FastifyInstance } from 'fastify';
import {
  CloseConversationRequest,
  CreateConversationRequest,
  DesignatePrimaryRequest,
  PaginationQuery,
  SendMessageRequest,
  type ErrorCode,
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
} from '../../conversation/conversation-service.ts';
import {
  PrimaryConversationClosedError,
  PrimaryConversationErroredError,
  PrimaryConversationNotFoundError,
  PrimaryTargetBusyError,
  type PrimaryService,
} from '../../conversation/primary-service.ts';
import type { StorageAdapter } from '../../storage/storage-adapter.ts';
import { sendError } from './errors.ts';

/**
 * Maps every known error thrown by ConversationService/PrimaryService's methods to its HTTP
 * status/code/details, mirroring edits.ts's `handleEditError` — one dispatch table instead of each
 * route handler repeating its own `if (err instanceof X) return sendError(...)` chain. A route
 * whose handler can throw a type not covered here (there are none currently) would simply get
 * `null` back and rethrow, same as edits.ts's pattern.
 */
function handleConversationError(
  err: unknown,
): { status: number; code: ErrorCode; details?: Record<string, unknown> } | null {
  if (err instanceof ConversationNotFoundError || err instanceof PrimaryConversationNotFoundError) {
    return { status: 404, code: 'CONVERSATION_NOT_FOUND' };
  }
  if (err instanceof ConversationClosedError || err instanceof PrimaryConversationClosedError) {
    return { status: 409, code: 'CONVERSATION_CLOSED' };
  }
  if (err instanceof ConversationNotClosedError) {
    return { status: 409, code: 'CONVERSATION_NOT_CLOSED' };
  }
  if (err instanceof ConversationNotErroredError) {
    return { status: 409, code: 'CONVERSATION_NOT_ERRORED' };
  }
  if (err instanceof PrimaryConversationErroredError) {
    return { status: 409, code: 'CONVERSATION_ERRORED' };
  }
  if (err instanceof AgentUnavailableError) {
    return { status: 502, code: 'AGENT_UNAVAILABLE' };
  }
  if (err instanceof MaxConversationDepthExceededError) {
    return {
      status: 409,
      code: 'MAX_CONVERSATION_DEPTH_EXCEEDED',
      details: { limit: err.limit, attemptedDepth: err.attemptedDepth },
    };
  }
  if (err instanceof MaxEditingDepthExceededError) {
    return {
      status: 409,
      code: 'MAX_EDITING_DEPTH_EXCEEDED',
      details: { limit: err.limit, attemptedDepth: err.attemptedDepth },
    };
  }
  if (err instanceof PendingEditsBlockCloseError) {
    return { status: 409, code: 'PENDING_EDITS_BLOCK_CLOSE', details: { pendingEditIds: err.pendingEditIds } };
  }
  if (err instanceof PrimaryTargetBusyError) {
    return { status: 409, code: 'PRIMARY_TARGET_BUSY', details: err.details };
  }
  return null;
}

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
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    try {
      return reply.send(conversationService.getOne(request.params.id));
    } catch (err) {
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
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
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
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
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/retry', async (request, reply) => {
    try {
      const result = await conversationService.retry(request.params.id);
      return reply.status(202).send(result);
    } catch (err) {
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
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
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/review', async (request, reply) => {
    try {
      const result = conversationService.review(request.params.id);
      return reply.status(201).send(result);
    } catch (err) {
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
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
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id/primary', async (request, reply) => {
    try {
      const result = await primaryService.clear(request.params.id);
      return reply.send(result);
    } catch (err) {
      const mapped = handleConversationError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
      throw err;
    }
  });
}
