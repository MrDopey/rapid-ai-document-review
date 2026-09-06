import type { FastifyInstance } from 'fastify';
import {
  CreateDocumentRequest,
  ExportDocumentQuery,
  PatchDocumentRequest,
} from '@rapid-ai-document-review/shared/contracts/http';
import { DocumentAlreadyExistsError, DocumentNotFoundError, type DocumentService } from '../../document/document-service.ts';
import type { RevisionService } from '../../document/revision-service.ts';
import { parseOrFail, sendError } from './errors.ts';

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { documentService: DocumentService; revisionService: RevisionService },
): void {
  const { documentService, revisionService } = deps;

  app.post('/api/document', async (request, reply) => {
    const data = parseOrFail(reply, CreateDocumentRequest, request.body);
    if (!data) return;
    try {
      const result = documentService.create(data.content, data.title);
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof DocumentAlreadyExistsError) {
        return sendError(reply, 409, 'DOCUMENT_ALREADY_EXISTS', err.message);
      }
      throw err;
    }
  });

  app.get('/api/document', async (_request, reply) => {
    const result = documentService.get();
    if (!result) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'No document has been created yet');
    }
    return reply.send(result);
  });

  app.patch('/api/document', async (request, reply) => {
    const data = parseOrFail(reply, PatchDocumentRequest, request.body);
    if (!data) return;
    try {
      const result = await documentService.applyChanges(data.baseRevision, data.changes, data.title);
      return reply.send(result);
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', err.message);
      }
      throw err;
    }
  });

  app.get('/api/document/export', async (request, reply) => {
    const data = parseOrFail(reply, ExportDocumentQuery, request.query);
    if (!data) return;
    const doc = documentService.get();
    if (!doc) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'No document has been created yet');
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
