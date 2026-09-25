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
    document_type     TEXT NOT NULL DEFAULT 'canvas',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    last_active_at    TEXT NOT NULL DEFAULT ''
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
                         CHECK (kind IN ('main', 'branch', 'review', 'thread-root', 'thread-branch')),

    pi_session_path    TEXT NOT NULL,

    status             TEXT NOT NULL
                         CHECK (status IN ('idle', 'working', 'errored', 'closed')),
    error_message      TEXT,

    is_primary         INTEGER NOT NULL DEFAULT 0,
    is_current_main    INTEGER NOT NULL DEFAULT 0,

    context_revision   INTEGER NOT NULL,
    branch_depth       INTEGER NOT NULL DEFAULT 0,

    seed_selection     TEXT,
    forked_from_message_id TEXT,
    pi_leaf_entry_id   TEXT,
    done_at            TEXT,
    seed_excerpt_text  TEXT,

    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    closed_at          TEXT,

    FOREIGN KEY (document_id) REFERENCES document(id),
    FOREIGN KEY (parent_id)   REFERENCES conversation(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_primary
    ON conversation (document_id) WHERE is_primary = 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_current_main
    ON conversation (document_id) WHERE is_current_main = 1`,
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
  // `listEventsByConversation` (storage/sqlite/index.ts) does `WHERE conversation_id = ?` for
  // every `GET /conversations/:id` (and send/retry/branch/discardIfEmpty via `buildMessages`) —
  // without this it's a full scan of the whole document's event table regardless of which
  // conversation is requested (measured: 17ms -> 200-250ms once the table held ~2,500 rows).
  `CREATE INDEX IF NOT EXISTS idx_conversation_event_conversation_id
    ON conversation_event (conversation_id)`,
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
  `CREATE TABLE IF NOT EXISTS list_item (
    id            TEXT PRIMARY KEY,
    document_id   TEXT NOT NULL,
    list          TEXT NOT NULL
                    CHECK (list IN ('todo', 'parking_lot')),
    text          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,

    FOREIGN KEY (document_id) REFERENCES document(id)
  )`,
  // No content_hash column: it is a pure function of `text` (computeContentHash), computed on
  // demand by ListItemService rather than stored, so it can never drift from the text it hashes
  // (data-model.md).
  `CREATE INDEX IF NOT EXISTS list_item_document_list
    ON list_item (document_id, list, created_at)`,
];

// ---- Versioned incremental migrations (existing-database upgrade path) ----
//
// Every statement above is `CREATE TABLE/INDEX IF NOT EXISTS`, which is a no-op against a table
// that already exists — so a column added to one of those `CREATE TABLE` bodies after a
// self-hosted install first ran (e.g. `conversation.forked_from_message_id`,
// `user_settings.soft_word_count_threshold`) would never actually reach that install's on-disk
// schema, and the first query touching it fails with "no such column" at runtime. `STATEMENTS`
// above stays the complete, current schema for a fresh install (a brand-new file already gets
// every column via `CREATE TABLE`); the list below is the additive, backward-compatible path for
// a database that predates one of these columns. Each entry only ever *adds* — no data loss risk.
//
// `PRAGMA user_version` gates re-checking a database that's already current (an `ALTER TABLE ADD
// COLUMN` is fine to run twice in the sense that `addColumnIfMissing` guards it either way, but
// there's no reason to run the `PRAGMA table_info` probe on every single startup once we know
// we're caught up). To add a future schema change: append a new entry with the next version
// number and an `apply` that does whatever `ALTER TABLE`s are needed — do not fold it back into
// the `CREATE TABLE IF NOT EXISTS` bodies above as the only place it lives.
interface Migration {
  version: number;
  apply: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply: (db) => {
      addColumnIfMissing(db, 'conversation', 'forked_from_message_id', 'TEXT');
      addColumnIfMissing(
        db,
        'user_settings',
        'soft_word_count_threshold',
        `INTEGER NOT NULL DEFAULT ${DEFAULT_USER_SETTINGS.softWordCountThreshold}`,
      );
    },
  },
  {
    version: 2,
    apply: (db) => {
      addColumnIfMissing(db, 'conversation', 'is_current_main', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(
        `UPDATE conversation SET is_current_main = 1 WHERE kind = 'main' AND status != 'closed'`,
      );
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_current_main
        ON conversation (document_id) WHERE is_current_main = 1`);
    },
  },
  {
    version: 3,
    apply: (db) => {
      addColumnIfMissing(db, 'document', 'last_active_at', `TEXT NOT NULL DEFAULT ''`);
      db.exec(`UPDATE document SET last_active_at = updated_at WHERE last_active_at = ''`);
    },
  },
  {
    version: 4,
    apply: (db) => {
      addColumnIfMissing(db, 'document', 'document_type', `TEXT NOT NULL DEFAULT 'canvas'`);

      // `conversation.kind`'s CHECK constraint (011-linear-thread-mode) is baked into the
      // `CREATE TABLE` body, unlike a plain column default — SQLite cannot widen an existing
      // table's CHECK via `ALTER TABLE ADD COLUMN`, so the whole table is rebuilt under one
      // `PRAGMA foreign_keys = OFF` window (referencing tables — staged_edit/conversation_event/
      // revision/conversation.parent_id itself — keep their FK clauses valid by table name across
      // the rename, they just must not be checked mid-rebuild).
      const columns = db.prepare(`PRAGMA table_info(conversation)`).all() as Array<{
        name: string;
      }>;
      const alreadyWidened = columns.some((c) => c.name === 'pi_leaf_entry_id');
      if (!alreadyWidened) {
        db.exec('PRAGMA foreign_keys = OFF;');
        try {
          db.exec(`CREATE TABLE conversation_new (
            id                 TEXT PRIMARY KEY,
            document_id        TEXT NOT NULL,
            parent_id          TEXT,
            name               TEXT NOT NULL,
            kind               TEXT NOT NULL
                                 CHECK (kind IN ('main', 'branch', 'review', 'thread-root', 'thread-branch')),

            pi_session_path    TEXT NOT NULL,

            status             TEXT NOT NULL
                                 CHECK (status IN ('idle', 'working', 'errored', 'closed')),
            error_message      TEXT,

            is_primary         INTEGER NOT NULL DEFAULT 0,
            is_current_main    INTEGER NOT NULL DEFAULT 0,

            context_revision   INTEGER NOT NULL,
            branch_depth       INTEGER NOT NULL DEFAULT 0,

            seed_selection     TEXT,
            forked_from_message_id TEXT,
            pi_leaf_entry_id   TEXT,
            done_at            TEXT,
            seed_excerpt_text  TEXT,

            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            closed_at          TEXT,

            FOREIGN KEY (document_id) REFERENCES document(id),
            FOREIGN KEY (parent_id)   REFERENCES conversation(id)
          )`);
          db.exec(`INSERT INTO conversation_new
            (id, document_id, parent_id, name, kind, pi_session_path, status, error_message,
             is_primary, is_current_main, context_revision, branch_depth, seed_selection,
             forked_from_message_id, pi_leaf_entry_id, done_at, seed_excerpt_text,
             created_at, updated_at, closed_at)
            SELECT
             id, document_id, parent_id, name, kind, pi_session_path, status, error_message,
             is_primary, is_current_main, context_revision, branch_depth, seed_selection,
             forked_from_message_id, NULL, NULL, NULL,
             created_at, updated_at, closed_at
            FROM conversation`);
          db.exec(`DROP TABLE conversation`);
          db.exec(`ALTER TABLE conversation_new RENAME TO conversation`);
          db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_primary
            ON conversation (document_id) WHERE is_primary = 1`);
          db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_current_main
            ON conversation (document_id) WHERE is_current_main = 1`);
        } finally {
          db.exec('PRAGMA foreign_keys = ON;');
        }
      }
    },
  },
];

/** Adds `table.column` with `definition` only if it isn't already there — safe to call whether
 *  the column arrived via the fresh-install `CREATE TABLE` body or a prior run of this same
 *  migration, so a migration's `apply` never has to know which case it's in. */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function applyMigrations(db: DatabaseSync): void {
  const { user_version: currentVersion } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  let latestApplied = currentVersion;
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    migration.apply(db);
    latestApplied = Math.max(latestApplied, migration.version);
  }
  if (latestApplied !== currentVersion) {
    // No parameter binding for PRAGMA in node:sqlite — `latestApplied` is our own integer, never
    // user input.
    db.exec(`PRAGMA user_version = ${latestApplied}`);
  }
}

/** True for a `CREATE [UNIQUE] INDEX` statement in `STATEMENTS` — as opposed to a `CREATE TABLE`
 *  one. See `migrate()`'s doc comment on why the two need to run in different phases. */
function isIndexStatement(statement: string): boolean {
  return /^\s*CREATE (UNIQUE )?INDEX/i.test(statement);
}

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // `STATEMENTS`' `CREATE TABLE IF NOT EXISTS` entries run first — a no-op against a database that
  // already has the table, so this step alone is always safe regardless of install age. Its
  // `CREATE INDEX IF NOT EXISTS` entries run LAST, after `applyMigrations` below, deliberately:
  // a partial index like `conversation_one_current_main` (WHERE is_current_main = 1) references a
  // column that only a fresh `CREATE TABLE` body has from the start — an existing install missing
  // it only gets it via `applyMigrations`' `addColumnIfMissing`, so creating the index any earlier
  // would fail with "no such column" against that install's still-unmigrated on-disk schema.
  for (const statement of STATEMENTS) {
    if (isIndexStatement(statement)) continue;
    db.exec(statement);
  }
  applyMigrations(db);
  for (const statement of STATEMENTS) {
    if (isIndexStatement(statement)) db.exec(statement);
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO user_settings (id, updated_at) VALUES (1, ?)`).run(now);
}
