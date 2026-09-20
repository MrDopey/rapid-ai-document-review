import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.ts';
import type {
  ConversationEventRow,
  ConversationListOptions,
  ConversationRow,
  DocumentChangeRow,
  DocumentRow,
  DocumentSnapshotRow,
  Page,
  RevisionListOptions,
  RevisionRow,
  StagedEditRow,
  StorageAdapter,
  UserSettingsRow,
} from '../storage-adapter.ts';

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string): T {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
}

function toBool(value: number | boolean | null | undefined): boolean {
  return Boolean(value);
}

interface DocumentDbRow {
  id: string;
  title: string;
  current_revision: number;
  pi_session_dir: string;
  document_type: string;
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

function mapDocument(row: DocumentDbRow): DocumentRow {
  return {
    id: row.id,
    title: row.title,
    currentRevision: row.current_revision,
    piSessionDir: row.pi_session_dir,
    documentType: row.document_type as DocumentRow['documentType'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  };
}

interface RevisionDbRow {
  id: number;
  document_id: string;
  revision: number;
  source: string;
  origin: string;
  conversation_id: string | null;
  staged_edit_id: string | null;
  restored_from: number | null;
  note: string | null;
  auto_applied: number;
  heads: string;
  created_at: string;
}

function mapRevision(row: RevisionDbRow): RevisionRow {
  return {
    id: row.id,
    documentId: row.document_id,
    revision: row.revision,
    source: row.source as RevisionRow['source'],
    origin: row.origin as RevisionRow['origin'],
    conversationId: row.conversation_id,
    stagedEditId: row.staged_edit_id,
    restoredFrom: row.restored_from,
    note: row.note,
    autoApplied: toBool(row.auto_applied),
    heads: row.heads,
    createdAt: row.created_at,
  };
}

interface ConversationDbRow {
  id: string;
  document_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  pi_session_path: string;
  status: string;
  error_message: string | null;
  is_primary: number;
  is_current_main: number;
  context_revision: number;
  branch_depth: number;
  seed_selection: string | null;
  forked_from_message_id: string | null;
  pi_leaf_entry_id: string | null;
  done_at: string | null;
  seed_excerpt_text: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function mapConversation(row: ConversationDbRow): ConversationRow {
  return {
    id: row.id,
    documentId: row.document_id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind as ConversationRow['kind'],
    piSessionPath: row.pi_session_path,
    status: row.status as ConversationRow['status'],
    errorMessage: row.error_message,
    isPrimary: toBool(row.is_primary),
    isCurrentMain: toBool(row.is_current_main),
    contextRevision: row.context_revision,
    branchDepth: row.branch_depth,
    seedSelection: row.seed_selection ? JSON.parse(row.seed_selection) : null,
    forkedFromMessageId: row.forked_from_message_id,
    piLeafEntryId: row.pi_leaf_entry_id,
    doneAt: row.done_at,
    seedExcerptText: row.seed_excerpt_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

interface StagedEditDbRow {
  id: string;
  document_id: string;
  conversation_id: string;
  pi_tool_call_id: string;
  source_revision: number;
  summary: string;
  operations: string;
  status: string;
  auto_applied: number;
  applied_revision: number | null;
  supersedes_id: string | null;
  conflict_detail: string | null;
  replacement_attempt: number;
  created_at: string;
  resolved_at: string | null;
}

function mapStagedEdit(row: StagedEditDbRow): StagedEditRow {
  return {
    id: row.id,
    documentId: row.document_id,
    conversationId: row.conversation_id,
    piToolCallId: row.pi_tool_call_id,
    sourceRevision: row.source_revision,
    summary: row.summary,
    operations: JSON.parse(row.operations),
    status: row.status as StagedEditRow['status'],
    autoApplied: toBool(row.auto_applied),
    appliedRevision: row.applied_revision,
    supersedesId: row.supersedes_id,
    conflictDetail: row.conflict_detail ? JSON.parse(row.conflict_detail) : null,
    replacementAttempt: row.replacement_attempt,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

interface ConversationEventDbRow {
  id: string;
  document_id: string;
  conversation_id: string | null;
  sequence: number;
  event_type: string;
  data: string;
  created_at: string;
}

function mapEvent(row: ConversationEventDbRow): ConversationEventRow {
  return {
    id: row.id,
    documentId: row.document_id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    eventType: row.event_type,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

interface UserSettingsDbRow {
  thinking_visible: number;
  revision_debounce_ms: number;
  max_concurrent_agents: number;
  max_editing_depth: number;
  max_conversation_depth: number;
  max_replacement_attempts: number;
  soft_word_count_threshold: number;
  updated_at: string;
}

function mapSettings(row: UserSettingsDbRow): UserSettingsRow {
  return {
    thinkingVisible: toBool(row.thinking_visible),
    revisionDebounceMs: row.revision_debounce_ms,
    maxConcurrentAgents: row.max_concurrent_agents,
    maxEditingDepth: row.max_editing_depth,
    maxConversationDepth: row.max_conversation_depth,
    maxReplacementAttempts: row.max_replacement_attempts,
    softWordCountThreshold: row.soft_word_count_threshold,
    updatedAt: row.updated_at,
  };
}

export class SqliteStorageAdapter implements StorageAdapter {
  private readonly db: DatabaseSync;
  /** 0 when no transaction is open on this connection; >0 while inside `transaction()`, counting
   *  nesting depth so an inner call composes with an outer one instead of issuing a second
   *  `BEGIN` (which `node:sqlite` rejects — "cannot start a transaction within a transaction"). */
  private transactionDepth = 0;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    migrate(this.db);
  }

  // ---- document ----

  getDocument(documentId: string): DocumentRow | null {
    const row = this.db.prepare('SELECT * FROM document WHERE id = ?').get(documentId) as
      DocumentDbRow | undefined;
    return row ? mapDocument(row) : null;
  }

  listDocuments(): DocumentRow[] {
    const rows = this.db
      .prepare('SELECT * FROM document ORDER BY last_active_at DESC')
      .all() as unknown as DocumentDbRow[];
    return rows.map(mapDocument);
  }

  createDocument(
    row: Omit<DocumentRow, 'currentRevision'> & { currentRevision?: number },
  ): DocumentRow {
    const currentRevision = row.currentRevision ?? 0;
    this.db
      .prepare(
        `INSERT INTO document
           (id, title, current_revision, pi_session_dir, document_type, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        currentRevision,
        row.piSessionDir,
        row.documentType,
        row.createdAt,
        row.updatedAt,
        row.lastActiveAt,
      );
    return { ...row, currentRevision };
  }

  updateDocumentRevision(id: string, currentRevision: number, updatedAt: string): void {
    this.db
      .prepare(`UPDATE document SET current_revision = ?, updated_at = ? WHERE id = ?`)
      .run(currentRevision, updatedAt, id);
  }

  updateDocumentTitle(id: string, title: string, updatedAt: string): void {
    this.db
      .prepare(`UPDATE document SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, updatedAt, id);
  }

  renameDocument(documentId: string, title: string): DocumentRow {
    const updatedAt = new Date().toISOString();
    this.updateDocumentTitle(documentId, title, updatedAt);
    const row = this.getDocument(documentId);
    if (!row) {
      throw new Error(`Document not found: ${documentId}`);
    }
    return row;
  }

  deleteDocument(documentId: string): void {
    // Deletion order respects the FK graph (`revision` -> conversation/staged_edit,
    // `staged_edit`/`conversation_event` -> conversation) since `foreign_keys = ON`.
    this.transaction(() => {
      this.db.prepare(`DELETE FROM revision WHERE document_id = ?`).run(documentId);
      this.db.prepare(`DELETE FROM staged_edit WHERE document_id = ?`).run(documentId);
      this.db.prepare(`DELETE FROM conversation_event WHERE document_id = ?`).run(documentId);
      this.db.prepare(`DELETE FROM conversation WHERE document_id = ?`).run(documentId);
      this.db.prepare(`DELETE FROM document_change WHERE document_id = ?`).run(documentId);
      this.db.prepare(`DELETE FROM document_snapshot WHERE document_id = ?`).run(documentId);
      this.db.prepare(`DELETE FROM document WHERE id = ?`).run(documentId);
    });
  }

  touchLastActive(documentId: string): void {
    this.db
      .prepare(`UPDATE document SET last_active_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), documentId);
  }

  // ---- revision ----

  createRevision(row: Omit<RevisionRow, 'id'>): RevisionRow {
    const result = this.db
      .prepare(
        `INSERT INTO revision
           (document_id, revision, source, origin, conversation_id, staged_edit_id,
            restored_from, note, auto_applied, heads, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.documentId,
        row.revision,
        row.source,
        row.origin,
        row.conversationId,
        row.stagedEditId,
        row.restoredFrom,
        row.note,
        row.autoApplied ? 1 : 0,
        row.heads,
        row.createdAt,
      );
    return { ...row, id: Number(result.lastInsertRowid) };
  }

  getRevision(documentId: string, revision: number): RevisionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM revision WHERE document_id = ? AND revision = ?`)
      .get(documentId, revision) as RevisionDbRow | undefined;
    return row ? mapRevision(row) : null;
  }

  getLatestRevision(documentId: string): RevisionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM revision WHERE document_id = ? ORDER BY revision DESC LIMIT 1`)
      .get(documentId) as RevisionDbRow | undefined;
    return row ? mapRevision(row) : null;
  }

  listRevisions(documentId: string, options: RevisionListOptions): Page<RevisionRow> {
    const beforeRevision = options.cursor
      ? decodeCursor<{ revision: number }>(options.cursor).revision
      : null;
    const rows = (beforeRevision === null
      ? this.db
          .prepare(`SELECT * FROM revision WHERE document_id = ? ORDER BY revision DESC LIMIT ?`)
          .all(documentId, options.limit + 1)
      : this.db
          .prepare(
            `SELECT * FROM revision WHERE document_id = ? AND revision < ?
               ORDER BY revision DESC LIMIT ?`,
          )
          .all(documentId, beforeRevision, options.limit + 1)) as unknown as RevisionDbRow[];

    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const items = pageRows.map(mapRevision);
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ revision: last.revision }) : null;
    return { items, nextCursor };
  }

  // ---- document_snapshot ----

  createSnapshot(row: Omit<DocumentSnapshotRow, 'id'> & { id?: string }): DocumentSnapshotRow {
    const id = row.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO document_snapshot (id, document_id, revision, data, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, row.documentId, row.revision, row.data, row.createdAt);
    return { ...row, id };
  }

  getLatestSnapshot(documentId: string): DocumentSnapshotRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM document_snapshot WHERE document_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(documentId) as
      | {
          id: string;
          document_id: string;
          revision: number;
          data: Uint8Array;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      documentId: row.document_id,
      revision: row.revision,
      data: row.data,
      createdAt: row.created_at,
    };
  }

  // ---- document_change ----

  appendChange(row: Omit<DocumentChangeRow, 'id'>): DocumentChangeRow {
    const result = this.db
      .prepare(`INSERT INTO document_change (document_id, data, created_at) VALUES (?, ?, ?)`)
      .run(row.documentId, row.data, row.createdAt);
    return { ...row, id: Number(result.lastInsertRowid) };
  }

  listChangesSince(documentId: string, afterChangeId: number): DocumentChangeRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM document_change WHERE document_id = ? AND id > ? ORDER BY id ASC`)
      .all(documentId, afterChangeId) as {
      id: number;
      document_id: string;
      data: Uint8Array;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      data: r.data,
      createdAt: r.created_at,
    }));
  }

  // ---- conversation ----

  createConversation(row: ConversationRow): ConversationRow {
    this.db
      .prepare(
        `INSERT INTO conversation
           (id, document_id, parent_id, name, kind, pi_session_path, status, error_message,
            is_primary, is_current_main, context_revision, branch_depth, seed_selection, forked_from_message_id,
            pi_leaf_entry_id, done_at, seed_excerpt_text,
            created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.documentId,
        row.parentId,
        row.name,
        row.kind,
        row.piSessionPath,
        row.status,
        row.errorMessage,
        row.isPrimary ? 1 : 0,
        row.isCurrentMain ? 1 : 0,
        row.contextRevision,
        row.branchDepth,
        row.seedSelection ? JSON.stringify(row.seedSelection) : null,
        row.forkedFromMessageId,
        row.piLeafEntryId,
        row.doneAt,
        row.seedExcerptText,
        row.createdAt,
        row.updatedAt,
        row.closedAt,
      );
    return row;
  }

  getConversation(id: string): ConversationRow | null {
    const row = this.db.prepare(`SELECT * FROM conversation WHERE id = ?`).get(id) as
      ConversationDbRow | undefined;
    return row ? mapConversation(row) : null;
  }

  getConversationsByIds(ids: string[]): ConversationRow[] {
    if (ids.length === 0) return [];
    // De-dupe so the placeholder count (and IN clause) stays bounded even if callers pass repeats.
    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM conversation WHERE id IN (${placeholders})`)
      .all(...uniqueIds) as unknown as ConversationDbRow[];
    return rows.map(mapConversation);
  }

  getMainConversation(documentId: string): ConversationRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversation WHERE document_id = ? AND kind = 'main' AND is_current_main = 1 LIMIT 1`,
      )
      .get(documentId) as ConversationDbRow | undefined;
    return row ? mapConversation(row) : null;
  }

  getThreadRoot(documentId: string): ConversationRow | null {
    const row = this.db
      .prepare(`SELECT * FROM conversation WHERE document_id = ? AND kind = 'thread-root' LIMIT 1`)
      .get(documentId) as ConversationDbRow | undefined;
    return row ? mapConversation(row) : null;
  }

  getPrimaryConversation(documentId: string): ConversationRow | null {
    const row = this.db
      .prepare(`SELECT * FROM conversation WHERE document_id = ? AND is_primary = 1 LIMIT 1`)
      .get(documentId) as ConversationDbRow | undefined;
    return row ? mapConversation(row) : null;
  }

  listConversations(documentId: string, options: ConversationListOptions): Page<ConversationRow> {
    const after = options.cursor
      ? decodeCursor<{ createdAt: string; id: string }>(options.cursor)
      : null;
    const rows = (after === null
      ? this.db
          .prepare(
            `SELECT * FROM conversation WHERE document_id = ?
               ORDER BY created_at ASC, id ASC LIMIT ?`,
          )
          .all(documentId, options.limit + 1)
      : this.db
          .prepare(
            `SELECT * FROM conversation WHERE document_id = ?
               AND (created_at > ? OR (created_at = ? AND id > ?))
               ORDER BY created_at ASC, id ASC LIMIT ?`,
          )
          .all(
            documentId,
            after.createdAt,
            after.createdAt,
            after.id,
            options.limit + 1,
          )) as unknown as ConversationDbRow[];

    const hasMore = rows.length > options.limit;
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
    const items = pageRows.map(mapConversation);
    const last = items.at(-1);
    const nextCursor =
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
    return { items, nextCursor };
  }

  listAllConversations(documentId: string): ConversationRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversation WHERE document_id = ? ORDER BY created_at ASC`)
      .all(documentId) as unknown as ConversationDbRow[];
    return rows.map(mapConversation);
  }

  updateConversation(id: string, patch: Partial<ConversationRow>): ConversationRow {
    const existing = this.getConversation(id);
    if (!existing) {
      throw new Error(`Conversation not found: ${id}`);
    }
    const merged: ConversationRow = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE conversation SET
           parent_id = ?, name = ?, kind = ?, pi_session_path = ?, status = ?, error_message = ?,
           is_primary = ?, is_current_main = ?, context_revision = ?, branch_depth = ?, seed_selection = ?,
           forked_from_message_id = ?, pi_leaf_entry_id = ?, done_at = ?, seed_excerpt_text = ?,
           updated_at = ?, closed_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.parentId,
        merged.name,
        merged.kind,
        merged.piSessionPath,
        merged.status,
        merged.errorMessage,
        merged.isPrimary ? 1 : 0,
        merged.isCurrentMain ? 1 : 0,
        merged.contextRevision,
        merged.branchDepth,
        merged.seedSelection ? JSON.stringify(merged.seedSelection) : null,
        merged.forkedFromMessageId,
        merged.piLeafEntryId,
        merged.doneAt,
        merged.seedExcerptText,
        merged.updatedAt,
        merged.closedAt,
        id,
      );
    return merged;
  }

  deleteConversation(id: string): void {
    this.db
      .prepare(`UPDATE conversation_event SET conversation_id = NULL WHERE conversation_id = ?`)
      .run(id);
    this.db.prepare(`DELETE FROM staged_edit WHERE conversation_id = ?`).run(id);
    this.db.prepare(`DELETE FROM conversation WHERE id = ?`).run(id);
  }

  // ---- staged_edit ----

  createStagedEdit(row: StagedEditRow): StagedEditRow {
    this.db
      .prepare(
        `INSERT INTO staged_edit
           (id, document_id, conversation_id, pi_tool_call_id, source_revision, summary,
            operations, status, auto_applied, applied_revision, supersedes_id, conflict_detail,
            replacement_attempt, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.documentId,
        row.conversationId,
        row.piToolCallId,
        row.sourceRevision,
        row.summary,
        JSON.stringify(row.operations),
        row.status,
        row.autoApplied ? 1 : 0,
        row.appliedRevision,
        row.supersedesId,
        row.conflictDetail ? JSON.stringify(row.conflictDetail) : null,
        row.replacementAttempt,
        row.createdAt,
        row.resolvedAt,
      );
    return row;
  }

  getStagedEdit(id: string): StagedEditRow | null {
    const row = this.db.prepare(`SELECT * FROM staged_edit WHERE id = ?`).get(id) as
      StagedEditDbRow | undefined;
    return row ? mapStagedEdit(row) : null;
  }

  getStagedEditByToolCall(conversationId: string, piToolCallId: string): StagedEditRow | null {
    const row = this.db
      .prepare(`SELECT * FROM staged_edit WHERE conversation_id = ? AND pi_tool_call_id = ?`)
      .get(conversationId, piToolCallId) as StagedEditDbRow | undefined;
    return row ? mapStagedEdit(row) : null;
  }

  listStagedEditsByConversation(conversationId: string): StagedEditRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM staged_edit WHERE conversation_id = ? ORDER BY created_at DESC`)
      .all(conversationId) as unknown as StagedEditDbRow[];
    return rows.map(mapStagedEdit);
  }

  listPendingStagedEdits(documentId: string): StagedEditRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM staged_edit WHERE document_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      )
      .all(documentId) as unknown as StagedEditDbRow[];
    return rows.map(mapStagedEdit);
  }

  updateStagedEdit(id: string, patch: Partial<StagedEditRow>): StagedEditRow {
    const existing = this.getStagedEdit(id);
    if (!existing) {
      throw new Error(`Staged edit not found: ${id}`);
    }
    const merged: StagedEditRow = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE staged_edit SET
           status = ?, auto_applied = ?, applied_revision = ?, supersedes_id = ?,
           conflict_detail = ?, replacement_attempt = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.status,
        merged.autoApplied ? 1 : 0,
        merged.appliedRevision,
        merged.supersedesId,
        merged.conflictDetail ? JSON.stringify(merged.conflictDetail) : null,
        merged.replacementAttempt,
        merged.resolvedAt,
        id,
      );
    return merged;
  }

  // ---- conversation_event ----

  appendEvent(
    row: Omit<ConversationEventRow, 'sequence'> & { sequence: number },
  ): ConversationEventRow {
    this.db
      .prepare(
        `INSERT INTO conversation_event
           (id, document_id, conversation_id, sequence, event_type, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.documentId,
        row.conversationId,
        row.sequence,
        row.eventType,
        JSON.stringify(row.data),
        row.createdAt,
      );
    return row;
  }

  getNextSequence(documentId: string): number {
    return this.getLatestSequence(documentId) + 1;
  }

  getLatestSequence(documentId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(sequence) AS maxSequence FROM conversation_event WHERE document_id = ?`)
      .get(documentId) as { maxSequence: number | null } | undefined;
    return row?.maxSequence ?? 0;
  }

  listEventsSince(documentId: string, sinceSequence: number | null): ConversationEventRow[] {
    const rows = (sinceSequence === null
      ? this.db
          .prepare(`SELECT * FROM conversation_event WHERE document_id = ? ORDER BY sequence ASC`)
          .all(documentId)
      : this.db
          .prepare(
            `SELECT * FROM conversation_event WHERE document_id = ? AND sequence > ?
               ORDER BY sequence ASC`,
          )
          .all(documentId, sinceSequence)) as unknown as ConversationEventDbRow[];
    return rows.map(mapEvent);
  }

  listEventsByConversation(conversationId: string): ConversationEventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversation_event WHERE conversation_id = ? ORDER BY sequence ASC`)
      .all(conversationId) as unknown as ConversationEventDbRow[];
    return rows.map(mapEvent);
  }

  // ---- user_settings ----

  getSettings(): UserSettingsRow {
    const row = this.db.prepare(`SELECT * FROM user_settings WHERE id = 1`).get() as
      UserSettingsDbRow | undefined;
    if (!row) {
      throw new Error('user_settings singleton row missing — migration did not run');
    }
    return mapSettings(row);
  }

  updateSettings(
    patch: Partial<Omit<UserSettingsRow, 'updatedAt'>>,
    updatedAt: string,
  ): UserSettingsRow {
    const existing = this.getSettings();
    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE user_settings SET
           thinking_visible = ?, revision_debounce_ms = ?, max_concurrent_agents = ?,
           max_editing_depth = ?, max_conversation_depth = ?, max_replacement_attempts = ?,
           soft_word_count_threshold = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        merged.thinkingVisible ? 1 : 0,
        merged.revisionDebounceMs,
        merged.maxConcurrentAgents,
        merged.maxEditingDepth,
        merged.maxConversationDepth,
        merged.maxReplacementAttempts,
        merged.softWordCountThreshold,
        updatedAt,
      );
    return { ...merged, updatedAt };
  }

  // ---- transaction ----

  /** See `StorageAdapter.transaction` for the contract (commit-on-return, rollback-on-throw, safe
   *  to nest). Gives callers with several related writes (e.g. applying a staged edit —
   *  updateStagedEdit, updateConversation, an Automerge splice/appendChange, and a new revision
   *  row) a way to make that whole sequence atomic, instead of a mid-sequence crash being able to
   *  leave e.g. a staged edit marked `applied` with no corresponding revision row. */
  transaction<T>(fn: () => T): T {
    const isOutermost = this.transactionDepth === 0;
    if (isOutermost) {
      this.db.exec('BEGIN');
    }
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.transactionDepth -= 1;
      if (isOutermost) {
        this.db.exec('COMMIT');
      }
      return result;
    } catch (err) {
      this.transactionDepth -= 1;
      if (isOutermost) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackErr) {
          // Best-effort: surfaces the original error, not a rollback failure that would only
          // happen if the connection itself is already broken.
          throw new AggregateError(
            [err, rollbackErr],
            'transaction failed and rollback also failed',
          );
        }
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
