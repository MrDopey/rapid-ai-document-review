# Phase 1 Data Model: Todo & Parking Lot Lists

This feature adds exactly one new table, `list_item`, and no changes to any existing table. It
introduces three new WebSocket event types (reusing the existing `conversation_event`/event-stream
mechanism, research.md R3) and no new Pi/Automerge state.

## ListItem (new table: `list_item`)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` (PK) | Server-generated (e.g. `li_<uuid>`). Unique across the whole table, which trivially satisfies FR-002's "unique within its list." |
| `documentId` | `string` (FK → `document.id`) | The list item's owning document (spec Assumptions: lists are document-scoped, not per-conversation). |
| `list` | `'todo' \| 'parking_lot'` | Discriminator; `CHECK (list IN ('todo','parking_lot'))`. Never changes after creation (Assumptions: "moving an item from one list to the other is out of scope"). |
| `text` | `string` | Non-empty, non-whitespace-only (FR-016). Plain text only — never rendered through the Markdown/HTML pipeline (Constitution Principle VI is out of scope by construction: render as plain text, never `v-html`/innerHTML). |
| `createdAt` | `string` (ISO timestamp) | Set once. Used with `id` as the tiebreaker for "append to end of list" ordering (Assumptions: no manual reordering). |
| `updatedAt` | `string` (ISO timestamp) | Bumped on every text change. |

`contentHash` is deliberately **not** a stored column. It is a pure function of `text` alone
(`computeContentHash(text)`, research.md R2) with no other inputs, so persisting it would just be
derived state that has to be kept in sync on every write — a needless way to introduce drift if any
write path ever updated `text` without also recomputing it. `ListItemService` computes it on demand,
every time a row needs to produce one: when serializing a `ListItemRow` to a `ListItemDto`, and when
validating an incoming agent `expected_content_hash` against the row's current `text`. The cost is trivial
(SHA-256 over a short string) given these lists' expected size (Technical Context: a handful to a
few dozen items).

**Validation rules**:
- `text` MUST be non-empty after trimming whitespace, for both agent-driven and user-driven writes
  (FR-016).
- `list` is immutable after creation.
- An agent's `update_list_item`/`remove_list_item` call MUST supply `expected_content_hash`; the
  call is rejected (not applied) when it doesn't equal `computeContentHash` of the row's current
  `text` (FR-008) — the rejection response includes the row's actual current `text` and freshly
  computed `contentHash`.
- A user's edit/delete (HTTP path) never carries or checks a hash (FR-019) — always applied
  immediately; the hash any subsequent agent call must match is simply whatever
  `computeContentHash` now returns for the row's new `text`, with nothing to update or invalidate.

**State transitions**: `list_item` has no status/lifecycle field — create → (any number of text
updates, each changing what `computeContentHash(text)` returns) → delete (hard delete, no
soft-delete/tombstone; a deleted item's id is simply gone from subsequent `listListItems` results
and any further tool call against that id returns the existing "identifier not found" error,
FR-007).

**Relationships**: Many `ListItem` rows per `Document`, partitioned into exactly two lists by
`list`. No relationship to `Conversation` — a `list_item` row lives as long as its `Document` does,
independent of which (or how many) conversations are open or focused.

## ListItemDto (wire shape, `app/shared/src/contracts/http.ts` and `events.ts`)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Same as storage `id`. |
| `text` | `string` | |
| `contentHash` | `string` | Computed on the fly from `text` at serialization time (not read from a stored column — there isn't one). Included so a frontend that itself drives an agent conversation (not in scope here, but kept consistent) could in principle observe it; the human-facing panel never needs to display it. |

No `documentId` field on the DTO — it is always scoped by the containing endpoint/event's own
`documentId`, exactly like `ConversationDto` (see `app/shared/src/contracts/http.ts`). No `list`
field either: every surface that delivers a `ListItemDto` already establishes which list it belongs
to some other way — bucketed under a `todo`/`parkingLot` key (`list_items` tool result, `GET`
response), carried once at the WS event envelope's own `data.list` rather than repeated per item, or
simply the same `list` the caller just supplied as the `POST` request's own input — so a per-item
`list` field would be pure repeated redundancy with zero information gain. (Contrast
`listItemToolResult` below, a *different*, non-bucketed type where `list` is cheap and genuinely
useful — e.g. to an activity-log renderer inspecting a tool result in isolation — so it is kept
there.) No `createdAt`/`updatedAt` either: nothing consumes them — the backend already returns both
lists pre-sorted in append order (`ListItemRow`'s own `createdAt`/`id` tiebreak, kept storage-side
only), the agent has no use for timestamps (no FR asks it to reason about timing), and the spec
doesn't call for the panel to display "added on"/"last edited." Carrying them on the wire would be
pure unused payload on every tool call, HTTP response, and WS event.

## SQLite DDL (mirrors `app/backend/src/storage/sqlite/migrations.ts` conventions)

```sql
CREATE TABLE IF NOT EXISTS list_item (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL,
  list          TEXT NOT NULL
                  CHECK (list IN ('todo', 'parking_lot')),
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  FOREIGN KEY (document_id) REFERENCES document(id)
);
-- No content_hash column: it is a pure function of `text` (computeContentHash), computed on
-- demand by ListItemService rather than stored, so it can never drift from the text it hashes.

CREATE INDEX IF NOT EXISTS list_item_document_list
  ON list_item (document_id, list, created_at);
```

Added as a new `STATEMENTS` entry plus a new `MIGRATIONS` version bump, per the existing file's own
documented two-phase apply order (`CREATE TABLE IF NOT EXISTS` bodies first, then
`applyMigrations`, then `CREATE INDEX` statements last).

## StorageAdapter additions (`storage-adapter.ts` / `sqlite/index.ts`)

```ts
export interface ListItemRow {
  id: string;
  documentId: string;
  list: 'todo' | 'parking_lot';
  text: string;
  createdAt: string;
  updatedAt: string;
}

// on StorageAdapter:
createListItem(row: ListItemRow): ListItemRow;
getListItem(documentId: string, id: string): ListItemRow | null;
listListItems(documentId: string): ListItemRow[]; // both lists, ordered by list, then createdAt/id
updateListItemText(id: string, text: string, updatedAt: string): ListItemRow;
deleteListItem(id: string): void;
```

`ListItemRow` never carries a hash — `StorageAdapter` only ever reads/writes `text`.
`computeContentHash(row.text)` (`app/backend/src/list-items/content-hash.ts`, research.md R2) is
called by `ListItemService`, one layer above storage, whenever a `ListItemDto` needs a `contentHash`
or an incoming agent `expected_content_hash` needs validating.

Same shape/placement convention as the existing `staged_edit`/`conversation` blocks in that
interface (grouped by entity, a one-line SQL-table-name comment above each group).
