import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/storage/sqlite/migrations.ts';

/**
 * Versioned ALTER-based schema upgrade path (cce9749). `migrate()`'s `STATEMENTS` list is
 * `CREATE TABLE/INDEX IF NOT EXISTS`, a no-op against a table that already exists on disk from a
 * self-hosted install predating a later column addition — so a column added to a `CREATE TABLE`
 * body after that install first ran would never actually reach it; the versioned `MIGRATIONS` list
 * (gated by `PRAGMA user_version`) is the additive, backward-compatible path that actually adds it.
 *
 * This simulates exactly that: a database whose `conversation`/`user_settings` tables predate
 * migration 1 (missing `forked_from_message_id`/`soft_word_count_threshold` respectively, per
 * migrations.ts's `MIGRATIONS[0]`), with `user_version` still at its default of 0.
 */
function createPreMigration1Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF;'); // avoid needing every referenced table for this narrow test
  db.exec(`CREATE TABLE conversation (
    id                 TEXT PRIMARY KEY,
    document_id        TEXT NOT NULL,
    parent_id          TEXT,
    name               TEXT NOT NULL,
    kind               TEXT NOT NULL,
    pi_session_path    TEXT NOT NULL,
    status             TEXT NOT NULL,
    error_message      TEXT,
    is_primary         INTEGER NOT NULL DEFAULT 0,
    context_revision   INTEGER NOT NULL,
    branch_depth       INTEGER NOT NULL DEFAULT 0,
    seed_selection     TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    closed_at          TEXT
  )`);
  db.exec(`CREATE TABLE user_settings (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),
    thinking_visible         INTEGER NOT NULL DEFAULT 0,
    revision_debounce_ms     INTEGER NOT NULL DEFAULT 300000,
    max_concurrent_agents    INTEGER NOT NULL DEFAULT 3,
    max_editing_depth        INTEGER NOT NULL DEFAULT 2,
    max_conversation_depth   INTEGER NOT NULL DEFAULT 3,
    max_replacement_attempts INTEGER NOT NULL DEFAULT 2,
    updated_at               TEXT NOT NULL
  )`);

  db.prepare(
    `INSERT INTO conversation
       (id, document_id, parent_id, name, kind, pi_session_path, status, is_primary, context_revision, branch_depth, created_at, updated_at)
     VALUES ('conv_old', 'doc_old', NULL, 'Main', 'main', '/tmp/main.jsonl', 'idle', 1, 1, 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO user_settings (id, updated_at) VALUES (1, '2025-01-01T00:00:00.000Z')`,
  ).run();

  return db;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('versioned ALTER-based schema migrations (cce9749)', () => {
  it('upgrades an old database in place, adding missing columns without losing existing data', () => {
    const db = createPreMigration1Database();
    expect(tableColumns(db, 'conversation')).not.toContain('forked_from_message_id');
    expect(tableColumns(db, 'user_settings')).not.toContain('soft_word_count_threshold');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      0,
    );

    migrate(db);

    expect(tableColumns(db, 'conversation')).toContain('forked_from_message_id');
    expect(tableColumns(db, 'user_settings')).toContain('soft_word_count_threshold');
    // Latest migration version as of 012-todo-parking-lists (adds list_item.conversation_id/message_id).
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      5,
    );

    // The pre-existing row survived the upgrade untouched, and the newly-added column on it reads
    // back as the migration's own DEFAULT (ALTER TABLE ADD COLUMN ... DEFAULT applies retroactively
    // to existing rows in SQLite).
    const conversation = db
      .prepare('SELECT * FROM conversation WHERE id = ?')
      .get('conv_old') as Record<string, unknown>;
    expect(conversation.name).toBe('Main');
    expect(conversation.document_id).toBe('doc_old');
    expect(conversation.forked_from_message_id).toBeNull();

    const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get() as Record<
      string,
      unknown
    >;
    expect(settings.updated_at).toBe('2025-01-01T00:00:00.000Z');
    expect(settings.soft_word_count_threshold).toBe(20_000);

    db.close();
  });

  it('re-applying migrate() against an already-current database is a no-op (idempotent)', () => {
    const db = createPreMigration1Database();
    migrate(db);
    const afterFirst = {
      version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      conversationColumns: tableColumns(db, 'conversation'),
      settingsColumns: tableColumns(db, 'user_settings'),
      conversation: db.prepare('SELECT * FROM conversation WHERE id = ?').get('conv_old'),
    };

    expect(() => migrate(db)).not.toThrow();

    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      afterFirst.version,
    );
    expect(tableColumns(db, 'conversation')).toEqual(afterFirst.conversationColumns);
    expect(tableColumns(db, 'user_settings')).toEqual(afterFirst.settingsColumns);
    expect(db.prepare('SELECT * FROM conversation WHERE id = ?').get('conv_old')).toEqual(
      afterFirst.conversation,
    );

    db.close();
  });

  it('a brand-new (fresh-install) database already has both columns via CREATE TABLE, at the latest user_version', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(tableColumns(db, 'conversation')).toContain('forked_from_message_id');
    expect(tableColumns(db, 'user_settings')).toContain('soft_word_count_threshold');
    // Latest migration version as of 012-todo-parking-lists (adds list_item.conversation_id/message_id).
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      5,
    );
    db.close();
  });
});

/**
 * Migration version 2 (specs/006-archivable-main-conversation): `conversation.is_current_main`
 * plus the `conversation_one_current_main` partial unique index enforcing exactly one current
 * Main per document.
 */
describe('migration version 2: is_current_main (specs/006-archivable-main-conversation)', () => {
  it('a fresh install gets the column at the latest user_version, and its unique index rejects a second current-Main row for the same document', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(tableColumns(db, 'conversation')).toContain('is_current_main');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      5,
    );

    db.prepare(
      `INSERT INTO document (id, title, pi_session_dir, created_at, updated_at)
       VALUES ('doc_a', 'Doc A', '/tmp/pi', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO conversation
         (id, document_id, name, kind, pi_session_path, status, is_current_main, context_revision, created_at, updated_at)
       VALUES ('conv_a1', 'doc_a', 'Main', 'main', '/tmp/a1.jsonl', 'idle', 1, 1, 'now', 'now')`,
    ).run();

    // The unique partial index (`WHERE is_current_main = 1`) enforces at most one current-Main
    // per document — a second one for the same document is rejected outright, not silently allowed.
    expect(() =>
      db
        .prepare(
          `INSERT INTO conversation
             (id, document_id, name, kind, pi_session_path, status, is_current_main, context_revision, created_at, updated_at)
           VALUES ('conv_a2', 'doc_a', 'Second', 'branch', '/tmp/a2.jsonl', 'idle', 1, 1, 'now', 'now')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('an existing database missing the column gets it added, its single non-closed Main backfilled, and its unique index rejects a second current-Main row for the same document', () => {
    const db = createPreMigration1Database();
    expect(tableColumns(db, 'conversation')).not.toContain('is_current_main');

    migrate(db);

    expect(tableColumns(db, 'conversation')).toContain('is_current_main');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      5,
    );

    const conversation = db
      .prepare('SELECT * FROM conversation WHERE id = ?')
      .get('conv_old') as Record<string, unknown>;
    expect(conversation.is_current_main).toBe(1);

    db.prepare(
      `INSERT INTO document (id, title, pi_session_dir, created_at, updated_at)
       VALUES ('doc_old', 'Old Doc', '/tmp/pi', 'now', 'now')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO conversation
             (id, document_id, name, kind, pi_session_path, status, is_current_main, context_revision, created_at, updated_at)
           VALUES ('conv_old2', 'doc_old', 'Second Main', 'branch', '/tmp/old2.jsonl', 'idle', 1, 1, 'now', 'now')`,
        )
        .run(),
    ).toThrow();

    db.close();
  });

  it('does not backfill a closed kind=main row', () => {
    const db = createPreMigration1Database();
    db.prepare(`UPDATE conversation SET status = 'closed' WHERE id = 'conv_old'`).run();

    migrate(db);

    const conversation = db
      .prepare('SELECT * FROM conversation WHERE id = ?')
      .get('conv_old') as Record<string, unknown>;
    expect(conversation.is_current_main).toBe(0);
  });
});

/**
 * Migration version 3 (specs/010-multi-document-support): `document.last_active_at`, backfilled
 * from `updated_at` for any pre-existing row so a single-document install gets one correctly-
 * ordered dropdown entry (data-model.md's Document.lastActiveAt).
 */
describe('migration version 3: last_active_at (specs/010-multi-document-support)', () => {
  it('a fresh install gets the column at the latest user_version', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(tableColumns(db, 'document')).toContain('last_active_at');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      5,
    );
    db.close();
  });

  it('an existing document row missing the column gets it backfilled from updated_at', () => {
    const db = createPreMigration1Database();
    db.exec(`CREATE TABLE document (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      current_revision  INTEGER NOT NULL DEFAULT 0,
      pi_session_dir    TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )`);
    db.prepare(
      `INSERT INTO document (id, title, pi_session_dir, created_at, updated_at)
       VALUES ('doc_old', 'Old Doc', '/tmp/pi', '2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z')`,
    ).run();
    expect(tableColumns(db, 'document')).not.toContain('last_active_at');

    migrate(db);

    expect(tableColumns(db, 'document')).toContain('last_active_at');
    const document = db.prepare('SELECT * FROM document WHERE id = ?').get('doc_old') as Record<
      string,
      unknown
    >;
    expect(document.last_active_at).toBe('2025-06-01T00:00:00.000Z');

    db.close();
  });
});

/**
 * Migration version 4 (011-linear-thread-mode): `document.document_type` (plain `ADD COLUMN`) and
 * `conversation.kind`'s widened `CHECK` (`'thread-root'`/`'thread-branch'`), which — unlike a plain
 * column — SQLite cannot add via `ALTER TABLE`, so the whole `conversation` table is rebuilt.
 */
describe('migration version 4: document_type + widened conversation.kind (011-linear-thread-mode)', () => {
  it('a fresh install gets document_type and the widened kind CHECK at the latest user_version', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(tableColumns(db, 'document')).toContain('document_type');
    expect(tableColumns(db, 'conversation')).toContain('pi_leaf_entry_id');
    expect(tableColumns(db, 'conversation')).toContain('done_at');
    expect(tableColumns(db, 'conversation')).toContain('seed_excerpt_text');
    db.prepare(
      `INSERT INTO document (id, title, pi_session_dir, document_type, created_at, updated_at)
       VALUES ('doc_x', 'Doc X', '/tmp/pi', 'thread', 'now', 'now')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO conversation
             (id, document_id, name, kind, pi_session_path, status, context_revision, created_at, updated_at)
           VALUES ('conv_thread', 'doc_x', 'Thread', 'thread-root', '/tmp/t.jsonl', 'idle', 1, 'now', 'now')`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it('an existing database rebuilds conversation in place, preserving rows and widening the kind CHECK', () => {
    const db = createPreMigration1Database();
    expect(tableColumns(db, 'document')).not.toContain('document_type');
    expect(tableColumns(db, 'conversation')).not.toContain('pi_leaf_entry_id');

    migrate(db);

    expect(tableColumns(db, 'document')).toContain('document_type');
    const conversation = db
      .prepare('SELECT * FROM conversation WHERE id = ?')
      .get('conv_old') as Record<string, unknown>;
    expect(conversation.name).toBe('Main');
    expect(conversation.kind).toBe('main');
    expect(conversation.pi_leaf_entry_id).toBeNull();
    expect(conversation.done_at).toBeNull();
    expect(conversation.seed_excerpt_text).toBeNull();

    db.prepare(
      `INSERT INTO document (id, title, pi_session_dir, document_type, created_at, updated_at)
       VALUES ('doc_old', 'Old Doc', '/tmp/pi', 'thread', 'now', 'now')`,
    ).run();

    // The rebuilt table's conversation_one_primary unique partial index is still enforced after
    // the rebuild: a second Primary for the same document (conv_old is already Primary, per the
    // fixture) is rejected outright, not silently allowed.
    expect(() =>
      db
        .prepare(
          `INSERT INTO conversation
             (id, document_id, name, kind, pi_session_path, status, is_primary, context_revision, created_at, updated_at)
           VALUES ('conv_old_dup_primary', 'doc_old', 'Duplicate Primary', 'branch', '/tmp/dup.jsonl', 'idle', 1, 1, 'now', 'now')`,
        )
        .run(),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO conversation
             (id, document_id, name, kind, pi_session_path, status, context_revision, created_at, updated_at)
           VALUES ('conv_thread', 'doc_old', 'Thread', 'thread-branch', '/tmp/t.jsonl', 'idle', 1, 'now', 'now')`,
        )
        .run(),
    ).not.toThrow();

    db.close();
  });
});

/**
 * Migration version 5 (012-todo-parking-lists follow-up): `list_item.conversation_id`/
 * `message_id`, nullable, no backfill — `addColumnIfMissing` is idempotent whether the column
 * arrived via a fresh install's `CREATE TABLE` body or this migration.
 */
describe('migration version 5: list_item.conversation_id/message_id (012-todo-parking-lists)', () => {
  it('a fresh install already has both columns via CREATE TABLE, nullable, at the latest user_version', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(tableColumns(db, 'list_item')).toContain('conversation_id');
    expect(tableColumns(db, 'list_item')).toContain('message_id');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      5,
    );
    db.close();
  });

  it('an existing database missing the columns gets them added, nullable, without losing existing rows', () => {
    const db = createPreMigration1Database();
    db.exec(`CREATE TABLE list_item (
      id            TEXT PRIMARY KEY,
      document_id   TEXT NOT NULL,
      list          TEXT NOT NULL,
      text          TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )`);
    db.prepare(
      `INSERT INTO list_item (id, document_id, list, text, created_at, updated_at)
       VALUES ('li_old', 'doc_old', 'todo', 'pre-existing item', 'now', 'now')`,
    ).run();
    expect(tableColumns(db, 'list_item')).not.toContain('conversation_id');
    expect(tableColumns(db, 'list_item')).not.toContain('message_id');

    migrate(db);

    expect(tableColumns(db, 'list_item')).toContain('conversation_id');
    expect(tableColumns(db, 'list_item')).toContain('message_id');
    const item = db.prepare('SELECT * FROM list_item WHERE id = ?').get('li_old') as Record<
      string,
      unknown
    >;
    expect(item.text).toBe('pre-existing item');
    expect(item.conversation_id).toBeNull();
    expect(item.message_id).toBeNull();

    // Idempotent re-application: running `migrate()` again against an already-current database
    // does not re-add or otherwise disturb either column.
    expect(() => migrate(db)).not.toThrow();
    expect(tableColumns(db, 'list_item')).toContain('conversation_id');
    expect(tableColumns(db, 'list_item')).toContain('message_id');

    db.close();
  });
});
