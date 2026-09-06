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
  db.prepare(`INSERT INTO user_settings (id, updated_at) VALUES (1, '2025-01-01T00:00:00.000Z')`).run();

  return db;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('versioned ALTER-based schema migrations (cce9749)', () => {
  it('upgrades an old database in place, adding missing columns without losing existing data', () => {
    const db = createPreMigration1Database();
    expect(tableColumns(db, 'conversation')).not.toContain('forked_from_message_id');
    expect(tableColumns(db, 'user_settings')).not.toContain('soft_word_count_threshold');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0);

    migrate(db);

    expect(tableColumns(db, 'conversation')).toContain('forked_from_message_id');
    expect(tableColumns(db, 'user_settings')).toContain('soft_word_count_threshold');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);

    // The pre-existing row survived the upgrade untouched, and the newly-added column on it reads
    // back as the migration's own DEFAULT (ALTER TABLE ADD COLUMN ... DEFAULT applies retroactively
    // to existing rows in SQLite).
    const conversation = db.prepare('SELECT * FROM conversation WHERE id = ?').get('conv_old') as Record<
      string,
      unknown
    >;
    expect(conversation.name).toBe('Main');
    expect(conversation.document_id).toBe('doc_old');
    expect(conversation.forked_from_message_id).toBeNull();

    const settings = db.prepare('SELECT * FROM user_settings WHERE id = 1').get() as Record<string, unknown>;
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
    expect(db.prepare('SELECT * FROM conversation WHERE id = ?').get('conv_old')).toEqual(afterFirst.conversation);

    db.close();
  });

  it('a brand-new (fresh-install) database already has both columns via CREATE TABLE, at the latest user_version', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(tableColumns(db, 'conversation')).toContain('forked_from_message_id');
    expect(tableColumns(db, 'user_settings')).toContain('soft_word_count_threshold');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    db.close();
  });
});
