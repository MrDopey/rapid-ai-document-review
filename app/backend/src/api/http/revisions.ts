import type { FastifyInstance } from 'fastify';
import { PaginationQuery } from '@rapid-ai-document-review/shared/contracts/http';
import type { RevisionService } from '../../document/revision-service.ts';
import type { RevisionRow, StorageAdapter } from '../../storage/storage-adapter.ts';
import { parseOrFail, sendError } from './errors.ts';

function toRevisionDto(row: RevisionRow, conversationNamesById: Map<string, string>) {
  const conversationName = row.conversationId
    ? (conversationNamesById.get(row.conversationId) ?? null)
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
    const data = parseOrFail(reply, PaginationQuery, request.query);
    if (!data) return;
    const page = storage.listRevisions(doc.id, data);
    // Batch-resolve conversation names in one query instead of one lookup per revision row
    // (up to `limit` extra synchronous SQLite calls per page otherwise).
    const conversationIds = [
      ...new Set(page.items.map((r) => r.conversationId).filter((id): id is string => id !== null)),
    ];
    const conversationNamesById = new Map(
      storage.getConversationsByIds(conversationIds).map((c) => [c.id, c.name]),
    );
    return reply.send({
      revisions: page.items.map((r) => toRevisionDto(r, conversationNamesById)),
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
        const result = await revisionService.restore(doc.id, revisionNumber);
        return reply.send(result);
      } catch {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', `Revision not found: ${revisionNumber}`);
      }
    },
  );
}
