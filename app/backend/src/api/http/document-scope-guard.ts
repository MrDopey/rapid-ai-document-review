import { ConversationNotFoundError } from '../../conversation/conversation-service.ts';
import type { StorageAdapter } from '../../storage/storage-adapter.ts';

/** Every `:id`-scoped route identifies its row (conversation/thread/staged-edit) purely by that
 *  row's own globally-unique id, so without this check a valid id from a different document than
 *  the URL's `:documentId` would resolve as if it belonged there — surfacing another document's
 *  data (and, via the frontend's per-document event-sequence tracking, corrupting its own state)
 *  rather than 404ing like a genuinely unknown id does. Shared by conversations.ts, edits.ts, and
 *  threads.ts, whose routes all need this same defense. */
function rowBelongsToDocument<Row extends { documentId: string } | null>(
  documentId: string,
  row: Row,
): boolean {
  return row !== null && row.documentId === documentId;
}

export function conversationBelongsToDocument(
  storage: StorageAdapter,
  documentId: string,
  conversationId: string,
): boolean {
  return rowBelongsToDocument(documentId, storage.getConversation(conversationId));
}

export function editBelongsToDocument(
  storage: StorageAdapter,
  documentId: string,
  editId: string,
): boolean {
  return rowBelongsToDocument(documentId, storage.getStagedEdit(editId));
}

export function requireConversationInDocument(
  storage: StorageAdapter,
  documentId: string,
  conversationId: string,
): void {
  if (!conversationBelongsToDocument(storage, documentId, conversationId)) {
    throw new ConversationNotFoundError(`Conversation not found: ${conversationId}`);
  }
}

export function requireThreadInDocument(
  storage: StorageAdapter,
  documentId: string,
  threadId: string,
): void {
  if (!conversationBelongsToDocument(storage, documentId, threadId)) {
    throw new ConversationNotFoundError(`Thread not found: ${threadId}`);
  }
}
