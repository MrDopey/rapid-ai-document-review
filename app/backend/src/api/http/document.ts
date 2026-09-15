import type { FastifyInstance } from 'fastify';
import {
  CreateDocumentRequest,
  ExportDocumentQuery,
  PatchDocumentRequest,
} from '@rapid-ai-document-review/shared/contracts/http';
import {
  DocumentNotFoundError,
  DocumentOutOfSyncError,
  LastDocumentError,
  type DocumentService,
} from '../../document/document-service.ts';
import type { RevisionService } from '../../document/revision-service.ts';
import { parseOrFail, sendError } from './errors.ts';

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { documentService: DocumentService; revisionService: RevisionService },
): void {
  const { documentService, revisionService } = deps;

  app.post('/api/documents', async (request, reply) => {
    const data = parseOrFail(reply, CreateDocumentRequest, request.body);
    if (!data) return;
    const result = documentService.create(data.content, data.title);
    return reply.status(201).send(result);
  });

  app.get('/api/documents', async (_request, reply) => {
    return reply.send({ documents: documentService.listDocuments() });
  });

  app.get('/api/documents/:documentId', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const result = documentService.get(documentId);
    if (!result) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }
    // Fetching a document's full content/state is what "switching to it" means from the
    // frontend's perspective — recording it here is what makes `listDocuments`'s `isActive`
    // ordering, and restoring the active document across a restart, correct without any
    // separate session state.
    documentService.setActive(documentId);
    return reply.send(result);
  });

  app.patch('/api/documents/:documentId', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const data = parseOrFail(reply, PatchDocumentRequest, request.body);
    if (!data) return;
    try {
      if (
        data.baseRevision === undefined &&
        data.changes === undefined &&
        data.title !== undefined
      ) {
        const document = documentService.renameDocument(documentId, data.title);
        return reply.send({ currentRevision: document.currentRevision, revisionCreated: false });
      }
      const result = await documentService.applyChanges(
        documentId,
        data.baseRevision,
        data.changes,
        data.title,
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', err.message);
      }
      if (err instanceof DocumentOutOfSyncError) {
        return sendError(reply, 409, 'DOCUMENT_OUT_OF_SYNC', err.message, {
          currentRevision: err.currentRevision,
        });
      }
      throw err;
    }
  });

  app.delete('/api/documents/:documentId', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    try {
      documentService.deleteDocument(documentId);
      return reply.send({ id: documentId });
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', err.message);
      }
      if (err instanceof LastDocumentError) {
        return sendError(reply, 409, 'LAST_DOCUMENT', err.message);
      }
      throw err;
    }
  });

  app.get('/api/documents/:documentId/export', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const data = parseOrFail(reply, ExportDocumentQuery, request.query);
    if (!data) return;
    const doc = documentService.get(documentId);
    if (!doc) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }
    const content = revisionService.export(doc.document.id, data.revision);
    if (content === null) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', `Revision not found: ${data.revision}`);
    }
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    if (data.download) {
      reply.header('Content-Disposition', `attachment; filename="${doc.document.title}.md"`);
    }
    return reply.send(content);
  });
}
