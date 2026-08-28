import type { StagedEditDto } from '@rapid-ai-document-review/shared/contracts/http';
import type { StagedEditRow } from '../storage/storage-adapter.ts';

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
