# Data Model: Archivable Main Conversation

Convention (matching `specs/005-canvas-conversation-threads/data-model.md`): one heading per
entity/field, each tagged existing-vs-new and persisted-vs-derived.

## Conversation (existing entity, one field added)

`app/shared/src/domain/index.ts:35-66` (domain type), mirrored in
`app/backend/src/storage/storage-adapter.ts` (`ConversationRow`) and
`app/shared/src/contracts/http.ts` (`ConversationDto`).

- **New persisted field**: `isCurrentMain: boolean` (DB column `is_current_main`, `INTEGER NOT
  NULL DEFAULT 0`).
  - `true` only for the one `kind: 'main'` row per document that is the reviewer's current Main.
  - `false` for every other conversation, including every archived (former) Main.
  - Enforced unique at the storage layer: `CREATE UNIQUE INDEX conversation_one_current_main ON
    conversation (document_id) WHERE is_current_main = 1` — mirrors the existing
    `conversation_one_primary` partial index for `is_primary`. This is what makes FR-002/FR-006's
    "exactly one current Main, always" an invariant the database itself enforces, not just
    application sequencing.
  - Set `true` at Main creation (`ensureMain`, and `DocumentService.create`'s direct-insert path)
    and at archive-replace time for the new Main; set `false` on the old Main in the same
    transaction that flips it to `status: 'closed'`.
- **No change to existing fields' meaning**: `kind` stays `'main' | 'branch' | 'review'` — an
  archived Main keeps `kind: 'main'` (it is still "a Main," just no longer the current one).
  `status` stays `'idle' | 'working' | 'errored' | 'closed'` — archiving sets `status: 'closed'`,
  reusing every existing closed-conversation guarantee (`readOnly`, `canEdit: false`, `canBranch:
  false` — `conversation-mapper.ts:86-87,91`) with no new derived-field logic.
- **`isPrimary`** (existing): when the archived Main held Primary, it is cleared to `false` via the
  existing `PrimaryService.closeClears` path (FR-007) and never set on the new Main automatically —
  the new Main starts with `isPrimary: false` like any other freshly created conversation that
  isn't explicitly designated.
- **`parentId`**: `null` for every Main, current or archived — unchanged; a Main is never itself a
  branch.

## ConversationDto (existing HTTP/WS contract type, one field added)

`app/shared/src/contracts/http.ts:78-109`.

- **New field**: `isCurrentMain: z.boolean()` — the wire form of the new persisted field above, so
  the frontend can distinguish the current Main from an archived one without inferring it from
  `kind`+`status` combinations at every call site.

## Branch → archived-Main linkage (existing mechanism, unaffected)

`Conversation.parentId` (existing) continues to point at the archived Main's own row id — rows are
never deleted (`deleteConversation` is unused by this feature; archiving never calls it), so a
branch's `parentId` lookup (`conversationContinuity.ts:32-36`) keeps resolving correctly forever,
satisfying FR-005/US2 with zero new fields or migration.

## Revision → conversation attribution (existing mechanism, unaffected)

`Revision.conversationId` (existing, `app/shared/src/domain/index.ts:12-24`) is set once, at the
staged edit's creation time, from `StagedEdit.conversationId`, and is never rewritten when that
conversation is later archived (`revision-service.ts:105-159`, `edit-service.ts:332,365-371`).
`conversationName` is resolved live at read time from the (possibly archived) conversation row
(`revisions.ts:7-16,44-48`), so it displays correctly even after archival. FR-011/US3 hold with no
data-model change.

## Errors (new)

`app/backend/src/conversation/conversation-service.ts` (alongside the existing error classes at
lines 39-80).

- **`ConversationBusyError`** (new): thrown by `close()` (all kinds, including the Main-archive
  branch) when `conversation.status === 'working'`. Mapped in
  `app/backend/src/api/http/conversations.ts`'s `handleConversationError` to `409` /
  `CONVERSATION_BUSY` (new `ErrorCode` enum member,
  `app/shared/src/contracts/http.ts:35-54`).
- **`CannotCloseMainConversationError`** (existing, removed): its one throw site
  (`conversation-service.ts:411-414`) is deleted along with the `kind === 'main'` early-return it
  guards; the `CANNOT_CLOSE_MAIN_CONVERSATION` `ErrorCode` member and its contract test
  (`app/backend/tests/contract/http.test.ts:865-871`) are removed in the same change, since Main is
  no longer uncloseable.

## Migration (new versioned migration, `app/backend/src/storage/sqlite/migrations.ts`)

- Fresh installs: `conversation`'s `CREATE TABLE IF NOT EXISTS` body (`STATEMENTS`, lines 54-82)
  gains `is_current_main INTEGER NOT NULL DEFAULT 0`; a new `CREATE UNIQUE INDEX IF NOT EXISTS
  conversation_one_current_main ...` statement is added alongside the existing
  `conversation_one_primary` one.
- Existing installs: a new entry in `MIGRATIONS` (next `version` after the current `1`) that (a)
  `addColumnIfMissing(db, 'conversation', 'is_current_main', 'INTEGER NOT NULL DEFAULT 0')`, (b)
  backfills `UPDATE conversation SET is_current_main = 1 WHERE kind = 'main' AND status != 'closed'`
  (every existing document has exactly one such row today), then (c) creates the partial unique
  index — additive only, no data loss, following the documented policy at
  `migrations.ts:148-164`.
