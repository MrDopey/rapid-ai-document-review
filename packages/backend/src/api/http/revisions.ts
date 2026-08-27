import type { FastifyInstance } from 'fastify';
import { PaginationQuery } from '@rapid-ai-document-review/shared/contracts/http';
import type { RevisionService } from '../../document/revision-service.js';
import type { RevisionRow, StorageAdapter } from '../../storage/storage-adapter.js';
import { sendError } from './errors.js';

function toRevisionDto(storage: StorageAdapter, row: RevisionRow) {
  const conversationName = row.conversationId
    ? (storage.getConversation(row.conversationId)?.name ?? null)
    : null;
  return {
    revision: row.revision,
    source: row.source,
    origin: row.origin,
    conversationId: row.conversationId,
    conversationName,
    stagedEditId: row.stagedEditId,
    restoredFrom: row.restoredFrom,
    note: row.note,
    autoApplied: row.autoApplied,
    createdAt: row.createdAt,
  };
}

export function registerRevisionRoutes(
  app: FastifyInstance,
  deps: { storage: StorageAdapter; revisionService: RevisionService },
): void {
  const { storage, revisionService } = deps;

  app.get('/api/revisions', async (request, reply) => {
    const doc = storage.getDocument();
    if (!doc) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'No document has been created yet');
    }
    const parsed = PaginationQuery.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    const page = storage.listRevisions(doc.id, parsed.data);
    return reply.send({
      revisions: page.items.map((r) => toRevisionDto(storage, r)),
      nextCursor: page.nextCursor,
    });
  });

  app.post<{ Params: { revision: string } }>(
    '/api/revisions/:revision/restore',
    async (request, reply) => {
      const doc = storage.getDocument();
      if (!doc) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'No document has been created yet');
      }
      const revisionNumber = Number(request.params.revision);
      if (!Number.isInteger(revisionNumber)) {
        return sendError(reply, 400, 'VALIDATION_FAILED', 'revision must be an integer');
      }
      try {
        const result = revisionService.restore(doc.id, revisionNumber);
        return reply.send(result);
      } catch {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', `Revision not found: ${revisionNumber}`);
      }
    },
  );
}
