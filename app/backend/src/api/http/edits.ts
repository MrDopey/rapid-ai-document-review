import type { FastifyInstance } from 'fastify';
import type { ListEditsResponse } from '@rapid-ai-document-review/shared/contracts/http';
import { EditNotFoundError, EditNotPendingError, type EditService } from '../../edit/edit-service.ts';
import { sendError } from './errors.ts';

export function registerEditRoutes(app: FastifyInstance, deps: { editService: EditService }): void {
  const { editService } = deps;

  function handleEditError(err: unknown): { status: number; code: 'EDIT_NOT_FOUND' | 'EDIT_NOT_PENDING' } | null {
    if (err instanceof EditNotFoundError) return { status: 404, code: 'EDIT_NOT_FOUND' };
    if (err instanceof EditNotPendingError) return { status: 409, code: 'EDIT_NOT_PENDING' };
    return null;
  }

  app.get<{ Params: { id: string } }>('/api/conversations/:id/edits', async (request, reply) => {
    const response: ListEditsResponse = { stagedEdits: editService.listForConversation(request.params.id) };
    return reply.send(response);
  });

  app.get<{ Params: { id: string } }>('/api/edits/:id/preview', async (request, reply) => {
    try {
      return reply.send(editService.preview(request.params.id));
    } catch (err) {
      const mapped = handleEditError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/edits/:id/apply', async (request, reply) => {
    try {
      const { response } = await editService.apply(request.params.id);
      return reply.send(response);
    } catch (err) {
      const mapped = handleEditError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/edits/:id/drop', async (request, reply) => {
    try {
      const dropped = editService.drop(request.params.id);
      return reply.send({ outcome: 'dropped' as const, stagedEditId: dropped.id });
    } catch (err) {
      const mapped = handleEditError(err);
      if (mapped) return sendError(reply, mapped.status, mapped.code, (err as Error).message);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/edits/accept-remaining', async (request, reply) => {
    const result = await editService.acceptRemaining(request.params.id);
    return reply.send(result);
  });

  app.post<{ Params: { id: string } }>('/api/conversations/:id/edits/drop-remaining', async (request, reply) => {
    const droppedEditIds = editService.dropRemaining(request.params.id);
    return reply.send({ droppedEditIds });
  });
}
