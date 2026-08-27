import { z } from 'zod';

export const ConflictDetail = z.object({
  operations: z.array(
    z.object({
      index: z.number().int(),
      reason: z.enum(['not_found', 'ambiguous', 'overlapping']),
      occurrences: z.number().int(),
    }),
  ),
});
export type ConflictDetail = z.infer<typeof ConflictDetail>;

export const ErrorCode = z.enum([
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_ALREADY_EXISTS',
  'CONVERSATION_NOT_FOUND',
  'MAX_CONVERSATION_DEPTH_EXCEEDED',
  'MAX_EDITING_DEPTH_EXCEEDED',
  'CONVERSATION_CLOSED',
  'PENDING_EDITS_BLOCK_CLOSE',
  'PRIMARY_TARGET_BUSY',
  'EDIT_NOT_PENDING',
  'VALIDATION_FAILED',
  'AGENT_UNAVAILABLE',
  'CONVERSATION_NOT_ERRORED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string().max(500),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const DocumentDto = z.object({
  id: z.string(),
  title: z.string(),
  currentRevision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentDto = z.infer<typeof DocumentDto>;

export const ConversationDto = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['main', 'branch', 'review']),
  parentId: z.string().nullable(),
  branchDepth: z.number().int(),
  status: z.enum(['idle', 'working', 'errored', 'closed']),
  isPrimary: z.boolean(),
  contextRevision: z.number().int(),
  isStale: z.boolean(),
  pendingEditCount: z.number().int(),
  canEdit: z.boolean(),
  canBranch: z.boolean(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  readOnly: z.boolean().optional(),
});
export type ConversationDto = z.infer<typeof ConversationDto>;

export const StagedEditDto = z.object({
  id: z.string(),
  conversationId: z.string(),
  piToolCallId: z.string(),
  summary: z.string(),
  sourceRevision: z.number().int(),
  status: z.enum(['pending', 'applied', 'dropped', 'superseded']),
  autoApplied: z.boolean(),
  operationCount: z.number().int(),
  supersedesId: z.string().nullable(),
  conflictDetail: ConflictDetail.nullable(),
  appliedRevision: z.number().int().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type StagedEditDto = z.infer<typeof StagedEditDto>;

export const RevisionDto = z.object({
  revision: z.number().int(),
  source: z.enum(['user', 'agent']),
  origin: z.enum(['creation', 'manual_debounce', 'agent_edit', 'restore']),
  conversationId: z.string().nullable(),
  conversationName: z.string().nullable().optional(),
  stagedEditId: z.string().nullable().optional(),
  restoredFrom: z.number().int().nullable().optional(),
  note: z.string().nullable(),
  autoApplied: z.boolean(),
  createdAt: z.string(),
});
export type RevisionDto = z.infer<typeof RevisionDto>;

export const UserSettingsDto = z.object({
  thinkingVisible: z.boolean(),
  revisionDebounceMs: z.number().int().min(10_000).max(3_600_000),
  maxConcurrentAgents: z.number().int().min(1).max(10),
  maxEditingDepth: z.number().int().min(0).max(10),
  maxConversationDepth: z.number().int().min(1).max(10),
  maxReplacementAttempts: z.number().int().min(0).max(10),
});
export type UserSettingsDto = z.infer<typeof UserSettingsDto>;

export const UserSettingsPatch = UserSettingsDto.partial();
export type UserSettingsPatch = z.infer<typeof UserSettingsPatch>;

// ---- Pagination ----

export const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

// ---- Document ----

export const CreateDocumentRequest = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequest>;

export const CreateDocumentResponse = z.object({
  document: DocumentDto,
  content: z.string(),
  mainConversation: ConversationDto,
});
export type CreateDocumentResponse = z.infer<typeof CreateDocumentResponse>;

export const GetDocumentResponse = z.object({
  document: DocumentDto,
  content: z.string(),
  eventSequence: z.number().int(),
});
export type GetDocumentResponse = z.infer<typeof GetDocumentResponse>;

export const DocumentChangeSpec = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  insert: z.string(),
});
export type DocumentChangeSpec = z.infer<typeof DocumentChangeSpec>;

export const PatchDocumentRequest = z.object({
  baseRevision: z.number().int().optional(),
  changes: z.array(DocumentChangeSpec).optional(),
  title: z.string().min(1).optional(),
});
export type PatchDocumentRequest = z.infer<typeof PatchDocumentRequest>;

export const PatchDocumentResponse = z.object({
  currentRevision: z.number().int(),
  revisionCreated: z.boolean(),
});
export type PatchDocumentResponse = z.infer<typeof PatchDocumentResponse>;

export const ExportDocumentQuery = z.object({
  revision: z.coerce.number().int().optional(),
  download: z.coerce.boolean().optional(),
});
export type ExportDocumentQuery = z.infer<typeof ExportDocumentQuery>;

// ---- Revisions ----

export const ListRevisionsResponse = z.object({
  revisions: z.array(RevisionDto),
  nextCursor: z.string().nullable(),
});
export type ListRevisionsResponse = z.infer<typeof ListRevisionsResponse>;

export const PendingProposalReconciliationEntry = z.object({
  stagedEditId: z.string(),
  reconcilable: z.boolean(),
  conflictDetail: ConflictDetail.nullable().optional(),
});
export type PendingProposalReconciliationEntry = z.infer<
  typeof PendingProposalReconciliationEntry
>;

export const RestoreRevisionResponse = z.object({
  currentRevision: z.number().int(),
  restoredFrom: z.number().int(),
  content: z.string(),
  pendingProposalReconciliation: z.array(PendingProposalReconciliationEntry).optional(),
});
export type RestoreRevisionResponse = z.infer<typeof RestoreRevisionResponse>;

// ---- Conversations ----

export const ListConversationsResponse = z.object({
  currentRevision: z.number().int(),
  conversations: z.array(ConversationDto),
  nextCursor: z.string().nullable(),
});
export type ListConversationsResponse = z.infer<typeof ListConversationsResponse>;

export const CreateConversationRequest = z.object({
  parentConversationId: z.string(),
  name: z.string().min(1).optional(),
  selection: z.object({ from: z.number().int(), to: z.number().int() }).optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequest>;

export const MessageDto = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  reasoning: z.string().nullable().optional(),
  toolCalls: z
    .array(
      z.object({
        toolCallId: z.string(),
        name: z.string(),
        stagedEditId: z.string().nullable().optional(),
      }),
    )
    .optional(),
  createdAt: z.string(),
});
export type MessageDto = z.infer<typeof MessageDto>;

export const GetConversationResponse = z.object({
  conversation: ConversationDto,
  messages: z.array(MessageDto),
  stagedEdits: z.array(StagedEditDto),
});
export type GetConversationResponse = z.infer<typeof GetConversationResponse>;

export const SendMessageRequest = z.object({ message: z.string().min(1) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({
  accepted: z.boolean(),
  queued: z.boolean(),
  contextRevision: z.number().int(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const RefreshSendResponse = z.object({
  accepted: z.boolean(),
  queued: z.boolean(),
  contextRevision: z.number().int(),
  previousContextRevision: z.number().int(),
  includedStagedEditIds: z.array(z.string()),
});
export type RefreshSendResponse = z.infer<typeof RefreshSendResponse>;

export const RetryResponse = z.object({
  accepted: z.boolean(),
  status: z.literal('working'),
});
export type RetryResponse = z.infer<typeof RetryResponse>;

export const PrimaryWhenBusy = z.enum(['switch_now', 'cancel', 'switch_when_idle']);
export type PrimaryWhenBusy = z.infer<typeof PrimaryWhenBusy>;

export const DesignatePrimaryRequest = z.object({ whenBusy: PrimaryWhenBusy.optional() });
export type DesignatePrimaryRequest = z.infer<typeof DesignatePrimaryRequest>;

export const DesignatePrimaryResponse = z.object({
  primaryConversationId: z.string(),
  applied: z.enum(['immediately', 'deferred_until_idle', 'already_primary']),
  previousPrimaryId: z.string().nullable(),
  previousPrimaryStillWorking: z.boolean(),
});
export type DesignatePrimaryResponse = z.infer<typeof DesignatePrimaryResponse>;

export const ClearPrimaryResponse = z.object({
  primaryConversationId: z.null(),
  previousPrimaryId: z.string().nullable(),
});
export type ClearPrimaryResponse = z.infer<typeof ClearPrimaryResponse>;

export const CloseConversationRequest = z.object({
  foldSummaryIntoParent: z.boolean().default(false),
});
export type CloseConversationRequest = z.infer<typeof CloseConversationRequest>;

export const CloseConversationResponse = z.object({
  conversationId: z.string(),
  status: z.literal('closed'),
  summaryFoldedIntoParent: z.boolean(),
  parentConversationId: z.string().nullable(),
});
export type CloseConversationResponse = z.infer<typeof CloseConversationResponse>;

export const ReviewConversationResponse = z.object({
  conversation: ConversationDto,
  reviewedConversationIds: z.array(z.string()),
});
export type ReviewConversationResponse = z.infer<typeof ReviewConversationResponse>;

// ---- Edits ----

export const ListEditsResponse = z.object({
  stagedEdits: z.array(StagedEditDto),
});
export type ListEditsResponse = z.infer<typeof ListEditsResponse>;

export const EditHunk = z.object({
  operationIndex: z.number().int(),
  contextBefore: z.string(),
  removed: z.string(),
  added: z.string(),
  contextAfter: z.string(),
});
export type EditHunk = z.infer<typeof EditHunk>;

export const PreviewEditResponse = z.object({
  stagedEditId: z.string(),
  reconcilable: z.boolean(),
  fullPreview: z.string().nullable(),
  hunks: z.array(EditHunk),
  conflictDetail: ConflictDetail.nullable(),
});
export type PreviewEditResponse = z.infer<typeof PreviewEditResponse>;

export const ApplyEditResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('applied'),
    stagedEditId: z.string(),
    revision: z.number().int(),
    content: z.string(),
  }),
  z.object({
    outcome: z.literal('conflict'),
    stagedEditId: z.string(),
    supersededEditId: z.string(),
    conflictDetail: ConflictDetail,
    replacementRequested: z.boolean(),
    replacementAttempt: z.number().int(),
    attemptsRemaining: z.number().int(),
  }),
  z.object({
    outcome: z.literal('conflict_exhausted'),
    stagedEditId: z.string(),
    supersededEditId: z.string(),
    originalStagedEditId: z.string(),
    conflictDetail: ConflictDetail,
    replacementRequested: z.literal(false),
    attempts: z.number().int(),
  }),
]);
export type ApplyEditResponse = z.infer<typeof ApplyEditResponse>;

export const DropEditResponse = z.object({
  outcome: z.literal('dropped'),
  stagedEditId: z.string(),
});
export type DropEditResponse = z.infer<typeof DropEditResponse>;

export const AcceptRemainingResponse = z.object({
  results: z.array(
    z.object({
      stagedEditId: z.string(),
      outcome: z.enum(['applied', 'conflict', 'conflict_exhausted']),
      revision: z.number().int().optional(),
      replacementRequested: z.boolean().optional(),
    }),
  ),
  currentRevision: z.number().int(),
});
export type AcceptRemainingResponse = z.infer<typeof AcceptRemainingResponse>;

export const DropRemainingResponse = z.object({
  droppedEditIds: z.array(z.string()),
});
export type DropRemainingResponse = z.infer<typeof DropRemainingResponse>;
