import type { ConversationDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { ConversationRow, StorageAdapter } from '../storage/storage-adapter.js';

/** Server-computed fields (Principle V: enforcement lives here, never inferred by the UI). */
export function toConversationDto(
  storage: StorageAdapter,
  row: ConversationRow,
  currentRevision: number,
): ConversationDto {
  const settings = storage.getSettings();
  const pendingEditCount = storage
    .listStagedEditsByConversation(row.id)
    .filter((e) => e.status === 'pending').length;

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    branchDepth: row.branchDepth,
    status: row.status,
    isPrimary: row.isPrimary,
    contextRevision: row.contextRevision,
    isStale: row.contextRevision < currentRevision,
    pendingEditCount,
    canEdit: row.status !== 'closed' && row.branchDepth <= settings.maxEditingDepth,
    canBranch: row.status !== 'closed' && row.branchDepth < settings.maxConversationDepth,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    readOnly: row.status === 'closed',
  };
}
