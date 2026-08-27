export type RevisionSource = 'user' | 'agent';
export type RevisionOrigin = 'creation' | 'manual_debounce' | 'agent_edit' | 'restore';

export interface Document {
  id: string;
  title: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Revision {
  revision: number;
  documentId: string;
  source: RevisionSource;
  origin: RevisionOrigin;
  conversationId: string | null;
  conversationName: string | null;
  stagedEditId: string | null;
  restoredFrom: number | null;
  note: string | null;
  autoApplied: boolean;
  createdAt: string;
}

export type ConversationKind = 'main' | 'branch' | 'review';
export type ConversationStatus = 'idle' | 'working' | 'errored' | 'closed';

export interface ConversationSeedSelection {
  from: number;
  to: number;
  text: string;
}

export interface Conversation {
  id: string;
  documentId: string;
  parentId: string | null;
  name: string;
  kind: ConversationKind;
  status: ConversationStatus;
  errorMessage: string | null;
  isPrimary: boolean;
  contextRevision: number;
  branchDepth: number;
  seedSelection: ConversationSeedSelection | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;

  // Server-computed, never persisted
  isStale: boolean;
  canEdit: boolean;
  canBranch: boolean;
  pendingEditCount: number;
  readOnly: boolean;
}

export type StagedEditStatus = 'pending' | 'applied' | 'dropped' | 'superseded';
export type ConflictReason = 'not_found' | 'ambiguous' | 'overlapping';

export interface ConflictDetailOperation {
  index: number;
  reason: ConflictReason;
  occurrences: number;
}

export interface ConflictDetail {
  operations: ConflictDetailOperation[];
}

export interface EditOperation {
  old_string: string;
  new_string: string;
}

export interface StagedEdit {
  id: string;
  documentId: string;
  conversationId: string;
  piToolCallId: string;
  sourceRevision: number;
  summary: string;
  operations: EditOperation[];
  status: StagedEditStatus;
  autoApplied: boolean;
  appliedRevision: number | null;
  supersedesId: string | null;
  conflictDetail: ConflictDetail | null;
  replacementAttempt: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface UserSettings {
  thinkingVisible: boolean;
  revisionDebounceMs: number;
  maxConcurrentAgents: number;
  maxEditingDepth: number;
  maxConversationDepth: number;
  maxReplacementAttempts: number;
}
