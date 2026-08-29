// Row shapes mirror data-model.md exactly (camelCase in TS, snake_case in SQL).
// No caller issues SQL directly — every access to persisted state goes through this interface.

import type {
  ConflictDetail,
  ConflictDetailOperation,
  ConflictReason,
  ConversationKind,
  ConversationStatus,
  EditOperation,
  RevisionOrigin,
  RevisionSource,
  StagedEditStatus,
} from '@rapid-ai-document-review/shared/domain';

export type {
  ConflictDetail,
  ConflictDetailOperation,
  ConflictReason,
  ConversationKind,
  ConversationStatus,
  EditOperation,
  RevisionOrigin,
  RevisionSource,
  StagedEditStatus,
};

export interface DocumentRow {
  id: string;
  title: string;
  currentRevision: number;
  piSessionDir: string;
  createdAt: string;
  updatedAt: string;
}

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
  softWordCountThreshold: number;
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
  // Batch lookup for display-only joins (e.g. resolving revision -> conversation name for a page
  // of revisions in one query instead of one per row). Order/duplicates are not guaranteed to
  // match `ids`; callers should index the result by `id`.
  getConversationsByIds(ids: string[]): ConversationRow[];
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

  /**
   * Runs `fn` inside a single SQL transaction: commits if `fn` returns normally, rolls back and
   * rethrows if it throws. Safe to nest — an inner `transaction()` call while one is already open
   * (on the same adapter instance) just runs `fn` inline as part of the outer transaction rather
   * than opening a second one, so a caller that itself calls another method which also wraps its
   * own writes in `transaction()` composes correctly instead of hitting "cannot start a
   * transaction within a transaction". Everything stays synchronous — `fn` is never `async`.
   */
  transaction<T>(fn: () => T): T;

  close(): void;
}
