import type { FastifyInstance } from 'fastify';
import type { ListEditsResponse } from '@rapid-ai-document-review/shared/contracts/http';
import {
  EditNotFoundError,
  EditNotPendingError,
  type EditService,
} from '../../edit/edit-service.ts';
import type { StorageAdapter } from '../../storage/storage-adapter.ts';
import { conversationBelongsToDocument, editBelongsToDocument } from './document-scope-guard.ts';
import { sendError } from './errors.ts';

export function registerEditRoutes(
  app: FastifyInstance,
  deps: { editService: EditService; storage: StorageAdapter },
): void {
  const { editService, storage } = deps;

  function handleEditError(
    err: unknown,
  ): { status: number; code: 'EDIT_NOT_FOUND' | 'EDIT_NOT_PENDING' } | null {
    if (err instanceof EditNotFoundError) return { status: 404, code: 'EDIT_NOT_FOUND' };
    if (err instanceof EditNotPendingError) return { status: 409, code: 'EDIT_NOT_PENDING' };
    return null;
  }

  app.get<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/edits',
    async (request, reply) => {
      if (!conversationBelongsToDocument(storage, request.params.documentId, request.params.id)) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
      }
      const response: ListEditsResponse = {
        stagedEdits: editService.listForConversation(request.params.id),
      };
      return reply.send(response);
    },
  );

  app.get<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/edits/:id/preview',
    async (request, reply) => {
      if (!editBelongsToDocument(storage, request.params.documentId, request.params.id)) {
        return sendError(reply, 404, 'EDIT_NOT_FOUND', 'Staged edit not found');
      }
      try {
        return reply.send(editService.preview(request.params.id));
      } catch (err) {
        const mapped = handleEditError(err);
        if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
        throw err;
      }
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/edits/:id/apply',
    async (request, reply) => {
      if (!editBelongsToDocument(storage, request.params.documentId, request.params.id)) {
        return sendError(reply, 404, 'EDIT_NOT_FOUND', 'Staged edit not found');
      }
      try {
        const { response } = await editService.apply(request.params.id);
        return reply.send(response);
      } catch (err) {
        const mapped = handleEditError(err);
        if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
        throw err;
      }
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/edits/:id/drop',
    async (request, reply) => {
      if (!editBelongsToDocument(storage, request.params.documentId, request.params.id)) {
        return sendError(reply, 404, 'EDIT_NOT_FOUND', 'Staged edit not found');
      }
      try {
        const dropped = editService.drop(request.params.id);
        return reply.send({ outcome: 'dropped' as const, stagedEditId: dropped.id });
      } catch (err) {
        const mapped = handleEditError(err);
        if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
        throw err;
      }
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/edits/accept-remaining',
    async (request, reply) => {
      if (!conversationBelongsToDocument(storage, request.params.documentId, request.params.id)) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
      }
      try {
        const result = await editService.acceptRemaining(request.params.id);
        return reply.send(result);
      } catch (err) {
        const mapped = handleEditError(err);
        if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
        throw err;
      }
    },
  );

  app.post<{ Params: { documentId: string; id: string } }>(
    '/api/documents/:documentId/conversations/:id/edits/drop-remaining',
    async (request, reply) => {
      if (!conversationBelongsToDocument(storage, request.params.documentId, request.params.id)) {
        return sendError(reply, 404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
      }
      try {
        const droppedEditIds = editService.dropRemaining(request.params.id);
        return reply.send({ droppedEditIds });
      } catch (err) {
        const mapped = handleEditError(err);
        if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
        throw err;
      }
    },
  );
}
