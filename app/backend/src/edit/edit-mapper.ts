import type { StagedEditDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { StagedEditRow, StorageAdapter } from '../storage/storage-adapter.ts';

/** Shared row -> DTO mapping so `GET /conversations/:id`, `GET /conversations/:id/edits` and the
 * conversation detail response never drift into two independently-maintained shapes. */
export function toStagedEditDto(row: StagedEditRow): StagedEditDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    piToolCallId: row.piToolCallId,
    summary: row.summary,
    sourceRevision: row.sourceRevision,
    status: row.status,
    autoApplied: row.autoApplied,
    operationCount: row.operations.length,
    supersedesId: row.supersedesId,
    conflictDetail: row.conflictDetail,
    appliedRevision: row.appliedRevision,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/**
 * The ids of a conversation's still-`pending` staged edits — shared by
 * `ConversationService.close()` and `ThreadService.markDone()` (011-linear-thread-mode, FR-010,
 * research.md R3), so "close"/"mark done" enforce the identical unresolved-proposals rule from one
 * definition rather than each re-deriving it.
 */
export function getPendingStagedEditIds(storage: StorageAdapter, conversationId: string): string[] {
  return storage
    .listStagedEditsByConversation(conversationId)
    .filter((edit) => edit.status === 'pending')
    .map((edit) => edit.id);
}
