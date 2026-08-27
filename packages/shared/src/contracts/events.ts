import { z } from 'zod';
import { ConflictDetail, ConversationDto, DocumentDto } from './http.js';

const base = <TType extends string, TData extends z.ZodTypeAny>(type: TType, data: TData) =>
  z.object({
    type: z.literal(type),
    sequence: z.number().int().nullable(),
    documentId: z.string(),
    conversationId: z.string().nullable(),
    at: z.string(),
    data,
  });

const EPHEMERAL_TYPES = ['text_delta', 'thinking_delta', 'tool_output_delta'] as const;
export const EPHEMERAL_EVENT_TYPES: readonly string[] = EPHEMERAL_TYPES;

// ---- Document events ----

export const DocumentCreatedEvent = base(
  'document_created',
  z.object({
    documentId: z.string(),
    title: z.string(),
    revision: z.number().int(),
    content: z.string(),
  }),
);

export const DocumentContentChangedEvent = base(
  'document_content_changed',
  z.object({
    changes: z.array(z.object({ from: z.number().int(), to: z.number().int(), insert: z.string() })),
    currentRevision: z.number().int(),
    originConversationId: z.string().nullable(),
    contentHash: z.string(),
  }),
);

export const RevisionCreatedEvent = base(
  'revision_created',
  z.object({
    revision: z.number().int(),
    source: z.enum(['user', 'agent']),
    origin: z.enum(['creation', 'manual_debounce', 'agent_edit', 'restore']),
    conversationId: z.string().nullable(),
    note: z.string().nullable(),
    restoredFrom: z.number().int().nullable(),
  }),
);

export const RevisionRestoredEvent = base(
  'revision_restored',
  z.object({
    revision: z.number().int(),
    restoredFrom: z.number().int(),
    content: z.string(),
  }),
);

export const SettingsChangedEvent = base(
  'settings_changed',
  z.object({
    thinkingVisible: z.boolean(),
    revisionDebounceMs: z.number().int(),
    maxConcurrentAgents: z.number().int(),
    maxEditingDepth: z.number().int(),
    maxConversationDepth: z.number().int(),
    maxReplacementAttempts: z.number().int(),
  }),
);

// ---- Conversation lifecycle ----

export const ConversationStartedEvent = base(
  'conversation_started',
  z.object({
    conversationId: z.string(),
    name: z.string(),
    kind: z.enum(['main', 'branch', 'review']),
    parentId: z.string().nullable(),
    branchDepth: z.number().int(),
    contextRevision: z.number().int(),
    seedSelection: z.object({ from: z.number().int(), to: z.number().int(), text: z.string() }).nullable(),
  }),
);

export const ConversationStatusChangedEvent = base(
  'conversation_status_changed',
  z.object({
    status: z.enum(['idle', 'working', 'errored', 'closed']),
    previousStatus: z.enum(['idle', 'working', 'errored', 'closed']),
  }),
);

export const ConversationContextRefreshedEvent = base(
  'conversation_context_refreshed',
  z.object({
    contextRevision: z.number().int(),
    previousContextRevision: z.number().int(),
    includedStagedEditIds: z.array(z.string()),
  }),
);

export const ConversationStaleEvent = base(
  'conversation_stale',
  z.object({ contextRevision: z.number().int(), currentRevision: z.number().int() }),
);

export const ConversationClosedEvent = base(
  'conversation_closed',
  z.object({
    closedAt: z.string(),
    summaryFoldedIntoParent: z.boolean(),
    parentConversationId: z.string().nullable(),
  }),
);

export const ConversationSummaryFoldedEvent = base(
  'conversation_summary_folded',
  z.object({ parentConversationId: z.string(), summary: z.string() }),
);

export const PrimaryChangedEvent = base(
  'primary_changed',
  z.object({
    primaryConversationId: z.string().nullable(),
    previousPrimaryId: z.string().nullable(),
    applied: z.enum(['immediately', 'deferred_until_idle', 'already_primary', 'cleared']),
    previousPrimaryStillWorking: z.boolean(),
  }),
);

export const AgentErrorEvent = base(
  'agent_error',
  z.object({ message: z.string(), retryable: z.boolean() }),
);

// ---- Agent run and streaming ----

export const AgentStartedEvent = base('agent_started', z.object({ turnId: z.string() }));

export const AgentQueuedEvent = base(
  'agent_queued',
  z.object({
    queuePosition: z.number().int(),
    runningCount: z.number().int(),
    limit: z.number().int(),
  }),
);

export const AgentDequeuedEvent = base('agent_dequeued', z.object({ turnId: z.string() }));

export const MessageStartedEvent = base(
  'message_started',
  z.object({ messageId: z.string(), role: z.enum(['user', 'assistant']) }),
);

export const TextDeltaEvent = base(
  'text_delta',
  z.object({ messageId: z.string(), delta: z.string() }),
);

export const ThinkingDeltaEvent = base(
  'thinking_delta',
  z.object({ messageId: z.string(), delta: z.string() }),
);

export const MessageCompletedEvent = base(
  'message_completed',
  z.object({
    messageId: z.string(),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    reasoning: z.string().nullable(),
  }),
);

export const ToolStartedEvent = base(
  'tool_started',
  z.object({ toolCallId: z.string(), toolName: z.string() }),
);

export const ToolOutputDeltaEvent = base(
  'tool_output_delta',
  z.object({ toolCallId: z.string(), delta: z.string() }),
);

export const ToolCompletedEvent = base(
  'tool_completed',
  z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
    stagedEditId: z.string().nullable(),
  }),
);

export const AgentCompletedEvent = base('agent_completed', z.object({ turnId: z.string() }));

// ---- Proposed edits ----

export const StagedEditCreatedEvent = base(
  'staged_edit_created',
  z.object({
    stagedEditId: z.string(),
    piToolCallId: z.string(),
    summary: z.string(),
    sourceRevision: z.number().int(),
    operationCount: z.number().int(),
    supersedesId: z.string().nullable(),
  }),
);

export const StagedEditAppliedEvent = base(
  'staged_edit_applied',
  z.object({
    stagedEditId: z.string(),
    revision: z.number().int(),
    autoApplied: z.boolean(),
  }),
);

export const StagedEditDroppedEvent = base(
  'staged_edit_dropped',
  z.object({ stagedEditId: z.string() }),
);

export const StagedEditSupersededEvent = base(
  'staged_edit_superseded',
  z.object({
    stagedEditId: z.string(),
    conflictDetail: ConflictDetail,
    replacementRequested: z.boolean(),
    replacementAttempt: z.number().int(),
    attemptsRemaining: z.number().int(),
  }),
);

export const StagedEditReplacementCreatedEvent = base(
  'staged_edit_replacement_created',
  z.object({
    stagedEditId: z.string(),
    supersedesId: z.string(),
    summary: z.string(),
    replacementAttempt: z.number().int(),
  }),
);

export const StagedEditReplacementExhaustedEvent = base(
  'staged_edit_replacement_exhausted',
  z.object({
    stagedEditId: z.string(),
    originalStagedEditId: z.string(),
    attempts: z.number().int(),
    conflictDetail: ConflictDetail,
  }),
);

export const ApplicationEvent = z.discriminatedUnion('type', [
  DocumentCreatedEvent,
  DocumentContentChangedEvent,
  RevisionCreatedEvent,
  RevisionRestoredEvent,
  SettingsChangedEvent,
  ConversationStartedEvent,
  ConversationStatusChangedEvent,
  ConversationContextRefreshedEvent,
  ConversationStaleEvent,
  ConversationClosedEvent,
  ConversationSummaryFoldedEvent,
  PrimaryChangedEvent,
  AgentErrorEvent,
  AgentStartedEvent,
  AgentQueuedEvent,
  AgentDequeuedEvent,
  MessageStartedEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  MessageCompletedEvent,
  ToolStartedEvent,
  ToolOutputDeltaEvent,
  ToolCompletedEvent,
  AgentCompletedEvent,
  StagedEditCreatedEvent,
  StagedEditAppliedEvent,
  StagedEditDroppedEvent,
  StagedEditSupersededEvent,
  StagedEditReplacementCreatedEvent,
  StagedEditReplacementExhaustedEvent,
]);
export type ApplicationEvent = z.infer<typeof ApplicationEvent>;
export type ApplicationEventType = ApplicationEvent['type'];

// ---- Client -> server frames ----

export const SubscribeFrame = z.object({
  type: z.literal('subscribe'),
  sinceSequence: z.number().int().nullable(),
});
export type SubscribeFrame = z.infer<typeof SubscribeFrame>;

export const PingFrame = z.object({ type: z.literal('ping') });
export type PingFrame = z.infer<typeof PingFrame>;

export const ClientFrame = z.discriminatedUnion('type', [SubscribeFrame, PingFrame]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---- Server -> client control frames ----

export const SubscribedFrame = z.object({
  type: z.literal('subscribed'),
  sequence: z.null(),
  currentSequence: z.number().int(),
  replayCount: z.number().int(),
  snapshot: z.object({
    document: DocumentDto.extend({ content: z.string() }),
    conversations: z.array(ConversationDto),
  }),
});
export type SubscribedFrame = z.infer<typeof SubscribedFrame>;

export const PongFrame = z.object({ type: z.literal('pong') });
export type PongFrame = z.infer<typeof PongFrame>;
