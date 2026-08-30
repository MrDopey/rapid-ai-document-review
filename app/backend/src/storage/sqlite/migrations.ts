import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_USER_SETTINGS } from '@rapid-ai-document-review/shared/domain';

// DDL mirrors data-model.md exactly. All SQL lives here and in index.ts — no other module
// issues SQL directly (StorageAdapter is the sole abstraction boundary).
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS document (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    current_revision  INTEGER NOT NULL DEFAULT 0,
    pi_session_dir    TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS revision (
    id               INTEGER PRIMARY KEY,
    document_id      TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    source           TEXT NOT NULL
                       CHECK (source IN ('user', 'agent')),
    origin           TEXT NOT NULL
                       CHECK (origin IN ('creation', 'manual_debounce', 'agent_edit', 'restore')),
    conversation_id  TEXT,
    staged_edit_id   TEXT,
    restored_from    INTEGER,
    note             TEXT,
    auto_applied     INTEGER NOT NULL DEFAULT 0,
    heads            TEXT NOT NULL,
    created_at       TEXT NOT NULL,

    FOREIGN KEY (document_id)     REFERENCES document(id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(id),
    FOREIGN KEY (staged_edit_id)  REFERENCES staged_edit(id),

    UNIQUE (document_id, revision)
  )`,
  `CREATE TABLE IF NOT EXISTS document_snapshot (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL,

    FOREIGN KEY (document_id) REFERENCES document(id)
  )`,
  `CREATE TABLE IF NOT EXISTS document_change (
    id           INTEGER PRIMARY KEY,
    document_id  TEXT NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL,

    FOREIGN KEY (document_id) REFERENCES document(id)
  )`,
  `CREATE TABLE IF NOT EXISTS conversation (
    id                 TEXT PRIMARY KEY,
    document_id        TEXT NOT NULL,
    parent_id          TEXT,
    name               TEXT NOT NULL,
    kind               TEXT NOT NULL
                         CHECK (kind IN ('main', 'branch', 'review')),

    pi_session_path    TEXT NOT NULL,

    status             TEXT NOT NULL
                         CHECK (status IN ('idle', 'working', 'errored', 'closed')),
    error_message      TEXT,

    is_primary         INTEGER NOT NULL DEFAULT 0,

    context_revision   INTEGER NOT NULL,
    branch_depth       INTEGER NOT NULL DEFAULT 0,

    seed_selection     TEXT,
    forked_from_message_id TEXT,

    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    closed_at          TEXT,

    FOREIGN KEY (document_id) REFERENCES document(id),
    FOREIGN KEY (parent_id)   REFERENCES conversation(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_primary
    ON conversation (document_id) WHERE is_primary = 1`,
  `CREATE TABLE IF NOT EXISTS staged_edit (
    id                 TEXT PRIMARY KEY,
    document_id        TEXT NOT NULL,
    conversation_id    TEXT NOT NULL,
    pi_tool_call_id    TEXT NOT NULL,

    source_revision    INTEGER NOT NULL,
    summary            TEXT NOT NULL,
    operations         TEXT NOT NULL,

    status             TEXT NOT NULL
                         CHECK (status IN ('pending', 'applied', 'dropped', 'superseded')),
    auto_applied       INTEGER NOT NULL DEFAULT 0,

    applied_revision   INTEGER,
    supersedes_id      TEXT,
    conflict_detail    TEXT,
    replacement_attempt INTEGER NOT NULL DEFAULT 0,

    created_at         TEXT NOT NULL,
    resolved_at        TEXT,

    FOREIGN KEY (document_id)     REFERENCES document(id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(id),
    FOREIGN KEY (supersedes_id)   REFERENCES staged_edit(id),

    UNIQUE (conversation_id, pi_tool_call_id)
  )`,
  `CREATE TABLE IF NOT EXISTS conversation_event (
    id                TEXT PRIMARY KEY,
    document_id       TEXT NOT NULL,
    conversation_id   TEXT,
    sequence          INTEGER NOT NULL,
    event_type        TEXT NOT NULL,
    data              TEXT NOT NULL,
    created_at        TEXT NOT NULL,

    FOREIGN KEY (document_id)     REFERENCES document(id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(id),

    UNIQUE (document_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),

    thinking_visible         INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.thinkingVisible ? 1 : 0},
    revision_debounce_ms     INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.revisionDebounceMs},
    max_concurrent_agents    INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.maxConcurrentAgents},
    max_editing_depth        INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.maxEditingDepth},
    max_conversation_depth   INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.maxConversationDepth},
    max_replacement_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.maxReplacementAttempts},
    soft_word_count_threshold INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.softWordCountThreshold},

    updated_at               TEXT NOT NULL
  )`,
];

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const statement of STATEMENTS) {
    db.exec(statement);
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO user_settings (id, updated_at) VALUES (1, ?)`,
  ).run(now);
}
