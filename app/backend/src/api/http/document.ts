import type { FastifyInstance } from 'fastify';
import {
  CreateDocumentRequest,
  ExportDocumentQuery,
  PatchDocumentRequest,
} from '@rapid-ai-document-review/shared/contracts/http';
import { DocumentAlreadyExistsError, DocumentNotFoundError, type DocumentService } from '../../document/document-service.ts';
import type { RevisionService } from '../../document/revision-service.ts';
import { sendError } from './errors.ts';

export function registerDocumentRoutes(
  app: FastifyInstance,
  deps: { documentService: DocumentService; revisionService: RevisionService },
): void {
  const { documentService, revisionService } = deps;

  app.post('/api/document', async (request, reply) => {
    const parsed = CreateDocumentRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    try {
      const result = documentService.create(parsed.data.content, parsed.data.title);
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
    const parsed = PatchDocumentRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    try {
      const result = await documentService.applyChanges(
        parsed.data.baseRevision,
        parsed.data.changes,
        parsed.data.title,
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', err.message);
      }
      throw err;
    }
  });

  app.get('/api/document/export', async (request, reply) => {
    const parsed = ExportDocumentQuery.safeParse(request.query);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.error.message);
    }
    const doc = documentService.get();
    if (!doc) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', 'No document has been created yet');
    }
    const content = revisionService.export(doc.document.id, parsed.data.revision);
    if (content === null) {
      return sendError(reply, 404, 'DOCUMENT_NOT_FOUND', `Revision not found: ${parsed.data.revision}`);
    }
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    if (parsed.data.download) {
      reply.header('Content-Disposition', `attachment; filename="${doc.document.title}.md"`);
    }
    return reply.send(content);
  });
}
