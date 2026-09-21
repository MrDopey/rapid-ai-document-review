import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  CloseConversationRequest,
  CreateConversationRequest,
  DesignatePrimaryRequest,
  PaginationQuery,
  RenameConversationRequest,
  SendMessageRequest,
  type ErrorCode,
} from '@rapid-ai-document-review/shared/contracts/http';
import {
  AgentUnavailableError,
  ConversationBusyError,
  ConversationClosedError,
  ConversationNotClosedError,
  ConversationNotEmptyError,
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
import { DocumentNotFoundError } from '../../document/document-service.ts';
import { InvalidCursorError, type StorageAdapter } from '../../storage/storage-adapter.ts';
import { requireConversationInDocument } from './document-scope-guard.ts';
import { DocumentWrongTypeError, requireDocumentType } from './document-type-guard.ts';
import { parseOrFail, sendError } from './errors.ts';

/**
 * Maps every known error thrown by ConversationService/PrimaryService's methods to its HTTP
 * status/code/details — one dispatch table instead of each route handler below repeating its own
 * `if (err instanceof X) return sendError(...)` chain. A route whose handler throws a type not
 * covered here gets `null` back and rethrows.
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
  if (err instanceof ConversationBusyError) {
    return { status: 409, code: 'CONVERSATION_BUSY' };
  }
  if (err instanceof ConversationNotEmptyError) {
    return { status: 409, code: 'CONVERSATION_NOT_EMPTY' };
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
    return {
      status: 409,
      code: 'PENDING_EDITS_BLOCK_CLOSE',
      details: { pendingEditIds: err.pendingEditIds },
    };
  }
  if (err instanceof PrimaryTargetBusyError) {
    return { status: 409, code: 'PRIMARY_TARGET_BUSY', details: err.details };
  }
  if (err instanceof DocumentWrongTypeError) {
    return { status: 409, code: 'DOCUMENT_WRONG_TYPE' };
  }
  if (err instanceof DocumentNotFoundError) {
    return { status: 404, code: 'DOCUMENT_NOT_FOUND' };
  }
  if (err instanceof InvalidCursorError) {
    return { status: 400, code: 'VALIDATION_FAILED' };
  }
  return null;
}

async function withConversationErrors(
  reply: FastifyReply,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    const mapped = handleConversationError(err);
    if (mapped)
      return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
    throw err;
  }
}

export function registerConversationRoutes(
  app: FastifyInstance,
  deps: {
    conversationService: ConversationService;
    primaryService: PrimaryService;
    storage: StorageAdapter;
  },
): void {
  const { conversationService, primaryService, storage } = deps;

  app.get<{ Params: { documentId: string } }>(
    '/api/documents/:documentId/conversations',
    async (request, reply) => {
      const doc = storage.getDocument(request.params.documentId);
      if (!doc) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      const data = parseOrFail(reply, PaginationQuery, request.query);
      if (!data) return;
      return withConversationErrors(reply, async () => {
        return reply.send(conversationService.getAll(doc.id, data));
      });
    },
  );

  app.post<{ Params: { documentId: string } }>(
    '/api/documents/:documentId/conversations',
    async (request, reply) => {
      const data = parseOrFail(reply, CreateConversationRequest, request.body);
      if (!data) return;
      return withConversationErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'canvas');
        const conversation = conversationService.branch(data);
        return reply.status(201).send(conversation);
      });
    },
  );

  // 005-canvas-conversation-threads follow-up: discards an untouched branch placeholder (zero
  // messages, no children — see `ConversationService.discardIfEmpty`'s doc comment) outright,
  // rather than leaving it soft-closed forever. Distinct from `POST /:id/close` (FR-033), which
  // stays untouched by this addition.
  app.delete<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id',
    async (request, reply) => {
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = conversationService.discardIfEmpty(request.params.id);
        return reply.send(result);
      });
    },
  );

  app.get<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id',
    async (request, reply) => {
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        return reply.send(conversationService.getOne(request.params.id));
      });
    },
  );

  app.patch<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id',
    async (request, reply) => {
      const data = parseOrFail(reply, RenameConversationRequest, request.body);
      if (!data) return;
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const conversation = conversationService.rename(request.params.id, data.name);
        return reply.send(conversation);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/send',
    async (request, reply) => {
      const data = parseOrFail(reply, SendMessageRequest, request.body);
      if (!data) return;
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = await conversationService.send(request.params.id, data.message);
        return reply.status(202).send(result);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/refresh-send',
    async (request, reply) => {
      const data = parseOrFail(reply, SendMessageRequest, request.body);
      if (!data) return;
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = await conversationService.refreshAndSend(request.params.id, data.message);
        return reply.status(202).send(result);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/retry',
    async (request, reply) => {
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = await conversationService.retry(request.params.id);
        return reply.status(202).send(result);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/close',
    async (request, reply) => {
      const data = parseOrFail(reply, CloseConversationRequest, request.body ?? {});
      if (!data) return;
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = conversationService.close(request.params.id, data.foldSummaryIntoParent);
        return reply.send(result);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/review',
    async (request, reply) => {
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = conversationService.review(request.params.id);
        return reply.status(201).send(result);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/primary',
    async (request, reply) => {
      const data = parseOrFail(reply, DesignatePrimaryRequest, request.body ?? {});
      if (!data) return;
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = await primaryService.designate(request.params.id, data.whenBusy);
        return reply.send(result);
      });
    },
  );

  app.delete<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/primary',
    async (request, reply) => {
      return withConversationErrors(reply, async () => {
        requireConversationInDocument(storage, request.params.documentId, request.params.id);
        const result = await primaryService.clear(request.params.id);
        return reply.send(result);
      });
    },
  );
}
