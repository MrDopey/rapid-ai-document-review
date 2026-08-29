import { z } from 'zod';

// One definition per concept, reused everywhere a schema needs it (rather than each schema
// re-literaling its own copy of the same string array) — imported into contracts/events.ts too,
// since the same concepts recur in the event stream.
export const RevisionSource = z.enum(['user', 'agent']);
export type RevisionSource = z.infer<typeof RevisionSource>;

export const RevisionOrigin = z.enum(['creation', 'manual_debounce', 'agent_edit', 'restore']);
export type RevisionOrigin = z.infer<typeof RevisionOrigin>;

export const ConversationKind = z.enum(['main', 'branch', 'review']);
export type ConversationKind = z.infer<typeof ConversationKind>;

export const ConversationStatus = z.enum(['idle', 'working', 'errored', 'closed']);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const StagedEditStatus = z.enum(['pending', 'applied', 'dropped', 'superseded']);
export type StagedEditStatus = z.infer<typeof StagedEditStatus>;

export const ConflictReason = z.enum(['not_found', 'ambiguous', 'overlapping']);
export type ConflictReason = z.infer<typeof ConflictReason>;

export const ConflictDetail = z.object({
  operations: z.array(
    z.object({
      index: z.number().int(),
      reason: ConflictReason,
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
  'EDIT_NOT_FOUND',
  'VALIDATION_FAILED',
  'AGENT_UNAVAILABLE',
  'CONVERSATION_NOT_ERRORED',
  'CONVERSATION_ERRORED',
  'CONVERSATION_NOT_CLOSED',
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
  kind: ConversationKind,
  parentId: z.string().nullable(),
  branchDepth: z.number().int(),
  status: ConversationStatus,
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
  status: StagedEditStatus,
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
  source: RevisionSource,
  origin: RevisionOrigin,
  conversationId: z.string().nullable(),
  conversationName: z.string().nullable().optional(),
  stagedEditId: z.string().nullable().optional(),
  restoredFrom: z.number().int().nullable().optional(),
  note: z.string().nullable(),
  autoApplied: z.boolean(),
  createdAt: z.string(),
});
export type RevisionDto = z.infer<typeof RevisionDto>;

// Shape only, no range constraints: this describes GET/PATCH *responses*, which must always be
// parseable even if the stored value fell outside the currently-configured legal range before a
// tighter range was introduced (or, in dev/e2e, via a deliberate out-of-band seed). Range
// enforcement (FR-041) belongs solely to the write path — see `UserSettingsPatch` below.
export const UserSettingsDto = z.object({
  thinkingVisible: z.boolean(),
  revisionDebounceMs: z.number().int(),
  maxConcurrentAgents: z.number().int(),
  maxEditingDepth: z.number().int(),
  maxConversationDepth: z.number().int(),
  maxReplacementAttempts: z.number().int(),
  softWordCountThreshold: z.number().int(),
});
export type UserSettingsDto = z.infer<typeof UserSettingsDto>;

// The write path: every field optional (a PATCH may update any subset), but each present field
// is range-checked (FR-041) — out of range is `400 VALIDATION_FAILED`, never clamped.
export const UserSettingsPatch = z.object({
  thinkingVisible: z.boolean().optional(),
  revisionDebounceMs: z.number().int().min(10_000).max(3_600_000).optional(),
  maxConcurrentAgents: z.number().int().min(1).max(10).optional(),
  maxEditingDepth: z.number().int().min(0).max(10).optional(),
  maxConversationDepth: z.number().int().min(1).max(10).optional(),
  maxReplacementAttempts: z.number().int().min(0).max(10).optional(),
  // No fixed upper bound (spec Assumptions: configurable soft advisory threshold, default 20,000
  // words) — only a sensible floor so a degenerate near-zero value can't make the advisory fire
  // on virtually every document.
  softWordCountThreshold: z.number().int().min(1_000).optional(),
});
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
  // Nullable rather than always-a-string: a `cancel` response reports the (possibly nonexistent)
  // Primary as it stood before the request, and "no Primary" is a valid, reachable state
  // (FR-027a) that this field must be able to represent even on a no-op outcome.
  primaryConversationId: z.string().nullable(),
  applied: z.enum(['immediately', 'deferred_until_idle', 'already_primary', 'cancelled']),
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
