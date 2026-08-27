// Row shapes mirror data-model.md exactly (camelCase in TS, snake_case in SQL).
// No caller issues SQL directly — every access to persisted state goes through this interface.

export interface DocumentRow {
  id: string;
  title: string;
  currentRevision: number;
  piSessionDir: string;
  createdAt: string;
  updatedAt: string;
}

export type RevisionSource = 'user' | 'agent';
export type RevisionOrigin = 'creation' | 'manual_debounce' | 'agent_edit' | 'restore';

export interface RevisionRow {
  id: number;
  documentId: string;
  revision: number;
  source: RevisionSource;
  origin: RevisionOrigin;
  conversationId: string | null;
  stagedEditId: string | null;
  restoredFrom: number | null;
  note: string | null;
  autoApplied: boolean;
  heads: string; // JSON array of Automerge head hashes
  createdAt: string;
}

export interface DocumentSnapshotRow {
  id: string;
  documentId: string;
  revision: number;
  data: Uint8Array;
  createdAt: string;
}

export interface DocumentChangeRow {
  id: number;
  documentId: string;
  data: Uint8Array;
  createdAt: string;
}

export type ConversationKind = 'main' | 'branch' | 'review';
export type ConversationStatus = 'idle' | 'working' | 'errored' | 'closed';

export interface SeedSelection {
  from: number;
  to: number;
  text: string;
}

export interface ConversationRow {
  id: string;
  documentId: string;
  parentId: string | null;
  name: string;
  kind: ConversationKind;
  piSessionPath: string;
  status: ConversationStatus;
  errorMessage: string | null;
  isPrimary: boolean;
  contextRevision: number;
  branchDepth: number;
  seedSelection: SeedSelection | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
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

export interface StagedEditRow {
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

export interface ConversationEventRow {
  id: string;
  documentId: string;
  conversationId: string | null;
  sequence: number;
  eventType: string;
  data: unknown;
  createdAt: string;
}

export interface UserSettingsRow {
  thinkingVisible: boolean;
  revisionDebounceMs: number;
  maxConcurrentAgents: number;
  maxEditingDepth: number;
  maxConversationDepth: number;
  maxReplacementAttempts: number;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface RevisionListOptions {
  cursor?: string;
  limit: number;
}

export interface ConversationListOptions {
  cursor?: string;
  limit: number;
}

export interface StorageAdapter {
  // document
  getDocument(): DocumentRow | null;
  createDocument(row: Omit<DocumentRow, 'currentRevision'> & { currentRevision?: number }): DocumentRow;
  updateDocumentRevision(id: string, currentRevision: number, updatedAt: string): void;
  updateDocumentTitle(id: string, title: string, updatedAt: string): void;

  // revision
  createRevision(row: Omit<RevisionRow, 'id'>): RevisionRow;
  getRevision(documentId: string, revision: number): RevisionRow | null;
  getLatestRevision(documentId: string): RevisionRow | null;
  listRevisions(documentId: string, options: RevisionListOptions): Page<RevisionRow>;

  // document_snapshot
  createSnapshot(row: Omit<DocumentSnapshotRow, 'id'> & { id?: string }): DocumentSnapshotRow;
  getLatestSnapshot(documentId: string): DocumentSnapshotRow | null;

  // document_change
  appendChange(row: Omit<DocumentChangeRow, 'id'>): DocumentChangeRow;
  listChangesSince(documentId: string, afterChangeId: number): DocumentChangeRow[];

  // conversation
  createConversation(row: ConversationRow): ConversationRow;
  getConversation(id: string): ConversationRow | null;
  getMainConversation(documentId: string): ConversationRow | null;
  getPrimaryConversation(documentId: string): ConversationRow | null;
  listConversations(documentId: string, options: ConversationListOptions): Page<ConversationRow>;
  listAllConversations(documentId: string): ConversationRow[];
  updateConversation(id: string, patch: Partial<ConversationRow>): ConversationRow;

  // staged_edit
  createStagedEdit(row: StagedEditRow): StagedEditRow;
  getStagedEdit(id: string): StagedEditRow | null;
  getStagedEditByToolCall(conversationId: string, piToolCallId: string): StagedEditRow | null;
  listStagedEditsByConversation(conversationId: string): StagedEditRow[];
  listPendingStagedEdits(documentId: string): StagedEditRow[];
  updateStagedEdit(id: string, patch: Partial<StagedEditRow>): StagedEditRow;

  // conversation_event
  appendEvent(row: Omit<ConversationEventRow, 'sequence'> & { sequence: number }): ConversationEventRow;
  getNextSequence(documentId: string): number;
  getLatestSequence(documentId: string): number;
  listEventsSince(documentId: string, sinceSequence: number | null): ConversationEventRow[];
  listEventsByConversation(conversationId: string): ConversationEventRow[];

  // user_settings
  getSettings(): UserSettingsRow;
  updateSettings(patch: Partial<Omit<UserSettingsRow, 'updatedAt'>>, updatedAt: string): UserSettingsRow;

  close(): void;
}
