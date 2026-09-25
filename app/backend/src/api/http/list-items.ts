import type { FastifyInstance } from 'fastify';
import {
  CreateListItemRequest,
  UpdateListItemRequest,
} from '@rapid-ai-document-review/shared/contracts/http';
import { computeContentHash } from '../../list-items/content-hash.ts';
import {
  EmptyListItemTextError,
  ListItemNotFoundError,
  type ListItemService,
} from '../../list-items/list-item-service.ts';
import type { ListItemRow, StorageAdapter } from '../../storage/storage-adapter.ts';
import { parseOrFail, sendError } from './errors.ts';

function toDto(row: ListItemRow) {
  return { id: row.id, text: row.text, contentHash: computeContentHash(row.text) };
}

/**
 * The user's own path for User Story 4 — ordinary HTTP CRUD, never carrying or checking
 * `expected_content_hash` (FR-020, contracts/list-items-http-api.md): a user's edit/delete always
 * applies immediately, funneled through the same `ListItemService` the agent tool-call path uses
 * (`pi/tools/list-items.ts`), so a change from either source reaches every open client identically.
 */
export function registerListItemRoutes(
  app: FastifyInstance,
  deps: { listItemService: ListItemService; storage: StorageAdapter },
): void {
  const { listItemService, storage } = deps;

  function requireDocument(documentId: string): boolean {
    return storage.getDocument(documentId) !== null;
  }

  app.get<{ Params: { documentId: string } }>(
    '/api/documents/:documentId/list-items',
    async (request, reply) => {
      const { documentId } = request.params;
      if (!requireDocument(documentId)) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      return reply.send(listItemService.listItems(documentId));
    },
  );

  app.post<{ Params: { documentId: string } }>(
    '/api/documents/:documentId/list-items',
    async (request, reply) => {
      const { documentId } = request.params;
      if (!requireDocument(documentId)) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      const data = parseOrFail(reply, CreateListItemRequest, request.body);
      if (!data) return;

      try {
        const row = listItemService.addItem(documentId, data.list, data.text, null);
        return reply.status(201).send(toDto(row));
      } catch (err) {
        if (err instanceof EmptyListItemTextError) {
          return sendError(reply, 400, 'VALIDATION_FAILED', err.message);
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { documentId: string; itemId: string } }>(
    '/api/documents/:documentId/list-items/:itemId',
    async (request, reply) => {
      const { documentId, itemId } = request.params;
      if (!requireDocument(documentId)) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      const data = parseOrFail(reply, UpdateListItemRequest, request.body);
      if (!data) return;

      try {
        const row = listItemService.updateItem(documentId, itemId, data.text, null);
        return reply.send(toDto(row));
      } catch (err) {
        if (err instanceof EmptyListItemTextError) {
          return sendError(reply, 400, 'VALIDATION_FAILED', err.message);
        }
        if (err instanceof ListItemNotFoundError) {
          return sendError(reply, 404, 'LIST_ITEM_NOT_FOUND', 'List item not found');
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { documentId: string; itemId: string } }>(
    '/api/documents/:documentId/list-items/:itemId',
    async (request, reply) => {
      const { documentId, itemId } = request.params;
      if (!requireDocument(documentId)) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      }
      try {
        listItemService.removeItem(documentId, itemId, null);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof ListItemNotFoundError) {
          return sendError(reply, 404, 'LIST_ITEM_NOT_FOUND', 'List item not found');
        }
        throw err;
      }
    },
  );
}
