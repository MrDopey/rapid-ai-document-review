import { DocumentNotFoundError } from '../../document/document-service.ts';
import type { DocumentRow, StorageAdapter } from '../../storage/storage-adapter.ts';

/**
 * A document's type is fixed at creation (011-linear-thread-mode, FR-001/FR-014) and the two
 * document-scoped conversation surfaces never mix: canvas mode's `POST .../conversations` routes
 * and thread mode's `POST .../threads` routes each only ever operate on their own document type.
 * Thrown by `requireDocumentType` below when a route is called against the wrong one.
 */
export class DocumentWrongTypeError extends Error {}

export function requireDocumentType(
  storage: StorageAdapter,
  documentId: string,
  expected: 'canvas' | 'thread',
): DocumentRow {
  const document = storage.getDocument(documentId);
  if (!document) {
    throw new DocumentNotFoundError(`Document not found: ${documentId}`);
  }
  if (document.documentType !== expected) {
    throw new DocumentWrongTypeError(
      `Document ${documentId} is documentType '${document.documentType}', expected '${expected}'`,
    );
  }
  return document;
}
