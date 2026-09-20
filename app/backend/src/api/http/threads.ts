import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  BranchThreadRequest,
  ExportDocumentSessionQuery,
  RenameConversationRequest,
  SendMessageRequest,
  type ErrorCode,
} from '@rapid-ai-document-review/shared/contracts/http';
import {
  AgentUnavailableError,
  ConversationClosedError,
  ConversationNotErroredError,
  ConversationNotFoundError,
  MaxConversationDepthExceededError,
  type ConversationService,
} from '../../conversation/conversation-service.ts';
import {
  AnchorIsTipError,
  EmptyDocumentExportError,
  InvalidHighlightError,
  PendingEditsBlockDoneError,
  type ThreadService,
} from '../../conversation/thread-service.ts';
import { DocumentNotFoundError } from '../../document/document-service.ts';
import type { StorageAdapter } from '../../storage/storage-adapter.ts';
import { DocumentWrongTypeError, requireDocumentType } from './document-type-guard.ts';
import { parseOrFail, sendError } from './errors.ts';

/** Mirrors conversations.ts's own dispatch table — see its doc comment for why this shape exists. */
function handleThreadError(
  err: unknown,
): { status: number; code: ErrorCode; details?: Record<string, unknown> } | null {
  if (err instanceof ConversationNotFoundError) {
    return { status: 404, code: 'CONVERSATION_NOT_FOUND' };
  }
  if (err instanceof DocumentNotFoundError) {
    return { status: 404, code: 'DOCUMENT_NOT_FOUND' };
  }
  if (err instanceof DocumentWrongTypeError) {
    return { status: 409, code: 'DOCUMENT_WRONG_TYPE' };
  }
  if (err instanceof ConversationClosedError) {
    return { status: 409, code: 'CONVERSATION_CLOSED' };
  }
  if (err instanceof ConversationNotErroredError) {
    return { status: 409, code: 'CONVERSATION_NOT_ERRORED' };
  }
  if (err instanceof AgentUnavailableError) {
    return { status: 502, code: 'AGENT_UNAVAILABLE' };
  }
  if (err instanceof InvalidHighlightError) {
    return { status: 400, code: 'INVALID_HIGHLIGHT' };
  }
  if (err instanceof AnchorIsTipError) {
    return { status: 409, code: 'ANCHOR_IS_TIP' };
  }
  if (err instanceof MaxConversationDepthExceededError) {
    return {
      status: 409,
      code: 'MAX_CONVERSATION_DEPTH_EXCEEDED',
      details: { limit: err.limit, attemptedDepth: err.attemptedDepth },
    };
  }
  if (err instanceof PendingEditsBlockDoneError) {
    return {
      status: 409,
      code: 'PENDING_EDITS_BLOCK_DONE',
      details: { pendingEditIds: err.pendingEditIds },
    };
  }
  if (err instanceof EmptyDocumentExportError) {
    return { status: 409, code: 'EMPTY_DOCUMENT_EXPORT' };
  }
  return null;
}

async function withThreadErrors(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    const mapped = handleThreadError(err);
    if (mapped)
      return sendError(reply, mapped.status, mapped.code, (err as Error).message, mapped.details);
    throw err;
  }
}

/** Same defense as conversations.ts's `requireConversationInDocument` — a valid thread id from a
 *  different document than the URL's `:documentId` must 404, not silently resolve. */
function requireThreadInDocument(
  storage: StorageAdapter,
  documentId: string,
  threadId: string,
): void {
  const thread = storage.getConversation(threadId);
  if (!thread || thread.documentId !== documentId) {
    throw new ConversationNotFoundError(`Thread not found: ${threadId}`);
  }
}

/**
 * Linear thread mode's (011-linear-thread-mode) HTTP surface — a parallel set of routes to
 * conversations.ts's, scoped to `documentType: 'thread'` documents only (contracts/thread-mode.md).
 * `GET .../threads` and `.../send`/`.../messages` deliberately reuse `ConversationService`'s own
 * methods verbatim (FR-015) rather than duplicating them on `ThreadService`.
 */
export function registerThreadRoutes(
  app: FastifyInstance,
  deps: {
    threadService: ThreadService;
    conversationService: ConversationService;
    storage: StorageAdapter;
  },
): void {
  const { threadService, conversationService, storage } = deps;

  app.get<{ Params: { documentId: string } }>(
    '/api/documents/:documentId/threads',
    async (request, reply) => {
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        const response = conversationService.getAll(request.params.documentId, { limit: 100 });
        return reply.send({
          ...response,
          conversations: response.conversations.filter(
            (c) => c.kind === 'thread-root' || c.kind === 'thread-branch',
          ),
        });
      });
    },
  );

  // User Story 4/FR-013b (research.md R10): whole-document export — the entire shared Pi session
  // tree (every Thread/branch together), not one Thread's own path. A distinct, non-colliding path
  // from `.../threads/:id/export` below (different segment count — no routing ambiguity), returning
  // raw HTML (not a JSON DTO), mirroring `document.ts`'s own `GET .../export` convention.
  app.get<{ Params: { documentId: string } }>(
    '/api/documents/:documentId/threads/export',
    async (request, reply) => {
      const data = parseOrFail(reply, ExportDocumentSessionQuery, request.query);
      if (!data) return;
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        const result = await threadService.exportDocumentSession(request.params.documentId);
        reply.header('Content-Type', 'text/html; charset=utf-8');
        if (data.download) {
          reply.header(
            'Content-Disposition',
            `attachment; filename="document-${result.documentId}-export.html"`,
          );
        }
        return reply.send(result.html);
      });
    },
  );

  // Parity fix (011-linear-thread-mode follow-up): a Thread's own `name` (`ThreadCard.vue`'s header
  // title) can be renamed exactly the same way a canvas conversation's can — pure metadata, no
  // bearing on tool availability/branching. Reuses `ConversationService.rename` verbatim (FR-015's
  // own convention, already used by `.../send`/`.../retry` above) rather than duplicating it.
  app.patch<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/threads/:id',
    async (request, reply) => {
      const data = parseOrFail(reply, RenameConversationRequest, request.body);
      if (!data) return;
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        requireThreadInDocument(storage, request.params.documentId, request.params.id);
        const thread = conversationService.rename(request.params.id, data.name);
        return reply.send(thread);
      });
    },
  );

  app.get<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/threads/:id/messages',
    async (request, reply) => {
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        requireThreadInDocument(storage, request.params.documentId, request.params.id);
        return reply.send(conversationService.getOne(request.params.id));
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/threads/:id/send',
    async (request, reply) => {
      const data = parseOrFail(reply, SendMessageRequest, request.body);
      if (!data) return;
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        requireThreadInDocument(storage, request.params.documentId, request.params.id);
        const result = await conversationService.send(request.params.id, data.message);
        return reply.status(202).send(result);
      });
    },
  );

  // Parity fix (011-linear-thread-mode follow-up): a Thread's underlying agent turn can fail exactly
  // the same way a canvas conversation's can (both are the same `conversation` table row, driven by
  // the same PiService/event-bridge machinery — see `conversation_status_changed`/`agent_error` in
  // `contracts/events.ts`, emitted identically regardless of `kind`) — but Thread mode had no way to
  // retry one. Reuses `ConversationService.retry` verbatim (FR-015's own convention, already used
  // by `.../send` above) rather than duplicating its "re-send the last user message" logic on
  // `ThreadService`.
  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/threads/:id/retry',
    async (request, reply) => {
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        requireThreadInDocument(storage, request.params.documentId, request.params.id);
        const result = await conversationService.retry(request.params.id);
        return reply.status(202).send(result);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/threads/:id/branch',
    async (request, reply) => {
      const data = parseOrFail(reply, BranchThreadRequest, request.body);
      if (!data) return;
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        requireThreadInDocument(storage, request.params.documentId, request.params.id);
        const thread = threadService.branchFromHighlight({
          parentThreadId: request.params.id,
          anchorMessageId: data.anchorMessageId,
          highlightedText: data.highlightedText,
          name: data.name,
        });
        return reply.status(201).send(thread);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/threads/:id/done',
    async (request, reply) => {
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        requireThreadInDocument(storage, request.params.documentId, request.params.id);
        const result = threadService.markDone(request.params.id);
        return reply.send(result);
      });
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/threads/:id/reopen',
    async (request, reply) => {
      return withThreadErrors(reply, async () => {
        requireDocumentType(storage, request.params.documentId, 'thread');
        requireThreadInDocument(storage, request.params.documentId, request.params.id);
        const result = threadService.reopen(request.params.id);
        return reply.send(result);
      });
    },
  );
}
