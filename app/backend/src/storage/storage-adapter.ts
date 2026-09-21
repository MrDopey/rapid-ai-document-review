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
  /** Fixed at creation (FR-001/FR-014, 011-linear-thread-mode); no storage method ever changes it
   *  post-creation. `NOT NULL DEFAULT 'canvas'` so every pre-existing document is `'canvas'` after
   *  migration. */
  documentType: 'canvas' | 'thread';
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
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
  isCurrentMain: boolean;
  contextRevision: number;
  branchDepth: number;
  seedSelection: SeedSelection | null;
  /** Message-level fork anchor (005-canvas-conversation-threads) — see `Conversation.forkedFromMessageId`
   *  in the shared domain model for the full contract. Reused as-is by a `thread-branch` row
   *  (011-linear-thread-mode) as the id of the parent Thread's message whose highlighted passage
   *  triggered the branch. */
  forkedFromMessageId: string | null;
  /** This Thread's own current tip within its shared session file (011-linear-thread-mode) — the
   *  entry id `SessionManager.branch()` repositions the leaf to before this Thread accepts its
   *  next message. `null` for a `thread-root` that has not yet received its first message, and
   *  always `null` for `'main' | 'branch' | 'review'` rows. */
  piLeafEntryId: string | null;
  /** Non-`null` once a reviewer marks this Thread done (011-linear-thread-mode, FR-008/FR-009);
   *  orthogonal to `status` — a pure visibility/declutter flag, not a lifecycle terminal state.
   *  Always `null` for `'main' | 'branch' | 'review'` rows. */
  doneAt: string | null;
  /** The exact highlighted substring that seeded a `thread-branch` (011-linear-thread-mode,
   *  FR-005a) — stored so the frontend can render the seed banner without re-deriving it from the
   *  raw Pi session. `null` for `thread-root` and every non-thread `kind`. */
  seedExcerptText: string | null;
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

/**
 * Thrown by an adapter's cursor-based `list*` methods (e.g. `SqliteStorageAdapter.decodeCursor`)
 * when a caller-supplied `cursor` string doesn't decode to the expected shape — a malformed or
 * tampered-with value, not a legitimate "no more pages" signal. Route handlers that accept a
 * `cursor` query param (revisions.ts, conversations.ts) catch this and map it to `400
 * VALIDATION_FAILED`, the same as any other rejected request body/query.
 */
export class InvalidCursorError extends Error {}

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
  getDocument(documentId: string): DocumentRow | null;
  listDocuments(): DocumentRow[];
  createDocument(
    row: Omit<DocumentRow, 'currentRevision'> & { currentRevision?: number },
  ): DocumentRow;
  updateDocumentRevision(id: string, currentRevision: number, updatedAt: string): void;
  updateDocumentTitle(id: string, title: string, updatedAt: string): void;
  renameDocument(documentId: string, title: string): DocumentRow;
  deleteDocument(documentId: string): void;
  touchLastActive(documentId: string): void;

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
  /** The single `kind: 'thread-root'` row for a `documentType: 'thread'` document, or `null`
   *  (011-linear-thread-mode) — mirrors `getMainConversation`. */
  getThreadRoot(documentId: string): ConversationRow | null;
  getPrimaryConversation(documentId: string): ConversationRow | null;
  listConversations(documentId: string, options: ConversationListOptions): Page<ConversationRow>;
  listAllConversations(documentId: string): ConversationRow[];
  updateConversation(id: string, patch: Partial<ConversationRow>): ConversationRow;
  /**
   * Physically removes a conversation row (005-canvas-conversation-threads follow-up: discarding
   * an untouched branch placeholder — see `ConversationService.discardIfEmpty` — never used for
   * the ordinary `close()` lifecycle, which only ever flips `status`). Any of this conversation's
   * own `conversation_event` rows are re-pointed to `conversation_id: null` rather than deleted —
   * `getNextSequence`/`getLatestSequence` derive the next sequence number from `MAX(sequence)` over
   * the whole table, so deleting the highest-sequence row would free that number for reuse and
   * could desync an already-connected client's replay cursor. Any `staged_edit` rows scoped to it
   * are deleted outright (no such reuse concern there), though a caller is expected to only ever
   * call this for a conversation with none.
   */
  deleteConversation(id: string): void;

  // staged_edit
  createStagedEdit(row: StagedEditRow): StagedEditRow;
  getStagedEdit(id: string): StagedEditRow | null;
  getStagedEditByToolCall(conversationId: string, piToolCallId: string): StagedEditRow | null;
  listStagedEditsByConversation(conversationId: string): StagedEditRow[];
  listPendingStagedEdits(documentId: string): StagedEditRow[];
  updateStagedEdit(id: string, patch: Partial<StagedEditRow>): StagedEditRow;

  // conversation_event
  appendEvent(
    row: Omit<ConversationEventRow, 'sequence'> & { sequence: number },
  ): ConversationEventRow;
  getNextSequence(documentId: string): number;
  getLatestSequence(documentId: string): number;
  listEventsSince(documentId: string, sinceSequence: number | null): ConversationEventRow[];
  listEventsByConversation(conversationId: string): ConversationEventRow[];

  // user_settings
  getSettings(): UserSettingsRow;
  updateSettings(
    patch: Partial<Omit<UserSettingsRow, 'updatedAt'>>,
    updatedAt: string,
  ): UserSettingsRow;

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
