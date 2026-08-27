# Data Model: AI Document Review Application

**Feature**: `001-ai-document-review` | **Date**: 2026-08-25
**Derived from**: [spec.md](./spec.md) Key Entities + Functional Requirements, [design.md](../../design.md) §33, [research.md](./research.md)

All SQL below is the SQLite dialect used by the `node:sqlite` adapter (research R7) and lives behind
`StorageAdapter`; no caller issues SQL directly. Timestamps are ISO-8601 UTC strings. `document_id`
is present on every document-scoped row so the future multi-document capability is not precluded,
even though v1 creates exactly one document.

---

## Entity overview

```text
document ──┬── revision ──────────── (conversation_id nullable: agent-originated revisions)
           ├── document_snapshot
           ├── document_change            (Automerge incremental change log)
           └── conversation ──┬── conversation (parent_id: branch tree)
                              ├── staged_edit
                              └── conversation_event

user_settings  (singleton)
```

---

## 1. Document

The Markdown content under review. Exactly one row in v1 (FR-001: created once per installation,
never discarded).

```sql
CREATE TABLE document (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    current_revision  INTEGER NOT NULL DEFAULT 0,
    pi_session_dir    TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
```

| Field | Notes |
| --- | --- |
| `current_revision` | Highest logical revision number. Starts at 1 when the document is created; monotonically increasing, never reused. |
| `pi_session_dir` | Directory holding this document's Pi JSONL session files; passed to the SDK as `sessionDir` (research R1). Derived from `PI_SESSION_STORAGE_PATH` at creation and stored so restart recovery finds the same location. |

**Validation rules**
- `title` non-empty; defaults to the first Markdown heading in the pasted content, else `"Untitled"`.
- Creation requires non-empty Markdown content (FR-001; edge case: conversations cannot start before a document exists).
- No delete operation exists in v1 (FR-001, spec Assumptions).

**Derived state (not stored in this table)**
- The live Markdown text is the Automerge document's `content` field, reconstructed from
  `document_snapshot` + `document_change` (see §3/§4).

---

## 2. Revision

A named, logical milestone in the document's history — deliberately distinct from the Automerge
operation log (Constitution Principle IV, design §7).

```sql
CREATE TABLE revision (
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
    heads            TEXT NOT NULL,
    created_at       TEXT NOT NULL,

    FOREIGN KEY (document_id)     REFERENCES document(id),
    FOREIGN KEY (conversation_id) REFERENCES conversation(id),
    FOREIGN KEY (staged_edit_id)  REFERENCES staged_edit(id),

    UNIQUE (document_id, revision)
);
```

| Field | Notes |
| --- | --- |
| `source` | `user` or `agent` — the attribution SC-008 requires be unambiguous 100% of the time. |
| `origin` | Why the revision exists. Distinguishes the four creators in FR-004/FR-006/FR-025. |
| `conversation_id` | Required when `source = 'agent'`; identifies which conversation's agent produced it (FR-005, SC-008). NULL for user revisions. |
| `staged_edit_id` | The proposal that produced this revision, when `origin = 'agent_edit'`. Gives a direct audit link proposal → revision. |
| `restored_from` | The revision number restored, when `origin = 'restore'` (FR-006). |
| `note` | Human-readable note, e.g. `Applied edit from "Introduction Review"`. Required for agent-originated revisions (FR-005). |
| `heads` | JSON array of Automerge head hashes at this revision. Enables materialising the exact text of any past revision for history view and export (FR-007a) via `Automerge.view(doc, heads)`. |

**Validation rules**
- `source = 'agent'` ⇒ `conversation_id` and `note` both non-NULL.
- `origin = 'agent_edit'` ⇒ `staged_edit_id` non-NULL and `source = 'agent'`.
- `origin = 'restore'` ⇒ `restored_from` names an existing revision of the same document.
- `origin = 'manual_debounce'` ⇒ `source = 'user'` and `conversation_id IS NULL`.
- Rows are **append-only**: never updated, never deleted (Principle IV, FR-006).

**Revision creation triggers** (FR-004)
1. Document creation → `revision = 1`, `origin = 'creation'`, `source = 'user'`.
2. A staged edit applied, or a Primary edit auto-applied → `origin = 'agent_edit'`.
3. Manual editing followed by `revision_debounce_ms` of inactivity → `origin = 'manual_debounce'`.
   The debounce timer is per document, reset by each incoming manual change, and cancelled if an
   agent revision lands first (the pending manual changes then fold into the next debounce window).
4. Restore of revision *n* → new revision with `origin = 'restore'`, `restored_from = n`.

---

## 3. Document snapshot

Compacted Automerge state, so startup does not replay the entire change log.

```sql
CREATE TABLE document_snapshot (
    id           TEXT PRIMARY KEY,
    document_id  TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL,

    FOREIGN KEY (document_id) REFERENCES document(id)
);
```

`data` is the output of `Automerge.save(doc)`. One snapshot is written on document creation and
subsequently on a rolling basis (every N revisions or when the accumulated change log exceeds a size
threshold). Older snapshots may be pruned — they are a cache, not history; `document_change` plus the
earliest retained snapshot remains sufficient to reconstruct every revision's `heads`.

---

## 4. Document change

The incremental Automerge change log — the CRDT operation history that Principle IV keeps separate
from logical revisions.

```sql
CREATE TABLE document_change (
    id           INTEGER PRIMARY KEY,
    document_id  TEXT NOT NULL,
    data         BLOB NOT NULL,
    created_at   TEXT NOT NULL,

    FOREIGN KEY (document_id) REFERENCES document(id)
);
```

`data` holds bytes from `Automerge.saveIncremental(doc)`, appended after each applied change. Loading
= newest retained snapshot → `Automerge.load` → `loadIncremental` for each subsequent change row.
Rows are never deleted except when superseded by a snapshot that provably covers them.

---

## 5. Conversation

One thread of interaction with an agent, scoped to the document. The application stores metadata
only; Pi owns the conversation itself (Principle II).

```sql
CREATE TABLE conversation (
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

    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    closed_at          TEXT,

    FOREIGN KEY (document_id) REFERENCES document(id),
    FOREIGN KEY (parent_id)   REFERENCES conversation(id)
);

CREATE UNIQUE INDEX conversation_one_primary
    ON conversation (document_id) WHERE is_primary = 1;
```

| Field | Notes |
| --- | --- |
| `kind` | `main` (the always-present root, FR-009), `branch` (from a selection or another conversation), `review` (an independent review of a closed conversation, FR-036). |
| `pi_session_path` | Absolute path to this conversation's Pi JSONL file. **Opaque outside `PiService`** — nothing else reads or parses it (Principle II). |
| `status` | `idle` = exists, not currently running; `working` = an agent run is in flight; `errored` = a Pi/model call failed and the failure is visible with retry available (FR-038); `closed` = read-only (FR-035). |
| `is_primary` | **At most** one row per document has `1`, enforced by the partial unique index *and* by `PrimaryService` (FR-027). Zero rows with `1` is a valid, reachable state: the user may deselect Primary outright, and closing the Primary conversation leaves the document with none (FR-027a). The index permits this; `PrimaryService` must not treat "no Primary" as an error or silently elect a replacement. |
| `context_revision` | The document revision this conversation's context reflects (FR-016). Compared against `document.current_revision` to derive the "stale" indicator — staleness is computed, never stored. |
| `branch_depth` | `0` for Main; `parent.branch_depth + 1` otherwise. Compared against `max_conversation_depth` (FR-013) and `max_editing_depth` (FR-026). |
| `seed_selection` | JSON `{ from, to, text }` recording the highlighted range a branch was seeded from (FR-011/FR-012). NULL for Main. |

**Validation rules**
- `kind = 'main'` ⇒ `parent_id IS NULL`, `branch_depth = 0`, exactly one per document, created with the document (FR-001, FR-009), and never closable.
- `kind = 'branch'` ⇒ `parent_id` non-NULL.
- Creating a branch is rejected when `parent.branch_depth + 1 > max_conversation_depth` (FR-013, edge case) and when the parent is `closed` (FR-035, edge case).
- Participation in edit workflows (propose / apply / refresh-send) requires `branch_depth <= max_editing_depth` (FR-026, edge case) — enforced independently of the branching check.
- Closing requires zero `staged_edit` rows in `pending` status (FR-033).
- Becoming Primary requires `status != 'closed'` (FR-035, edge case).
- Closing a conversation with `is_primary = 1` sets it to `0` as part of the same transaction; the document is then left with no Primary (FR-027a). Main is created with `is_primary = 1` (FR-009).
- A `working` conversation found at startup was interrupted by the restart: recovery transitions it to `errored` with a retryable interruption message (FR-039a). No agent run is re-issued on boot.
- `closed_at` non-NULL ⟺ `status = 'closed'`.

**State transitions**

```text
                      ┌──────── retry ────────┐
                      ▼                       │
  (created) ──▶ idle ──▶ working ──▶ idle    │
                 │          │                 │
                 │          └──▶ errored ─────┘
                 │
                 └──▶ closed        (requires no pending staged edits; terminal)
```

`closed` is terminal: no reopen, no branching from it, no becoming Primary (FR-035). A closed
conversation remains fully readable, and a `review` conversation may be created *about* it without
mutating it (FR-036).

---

## 6. Staged edit (proposed edit)

An atomic, agent-produced candidate change. One `propose_document_edit` tool call → exactly one row
(Principle III, FR-020).

```sql
CREATE TABLE staged_edit (
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
);
```

| Field | Notes |
| --- | --- |
| `pi_tool_call_id` | The Pi tool-call id, received as the first argument of the custom tool's `execute` (research R1). The `UNIQUE (conversation_id, pi_tool_call_id)` constraint is the idempotency guarantee FR-040 requires: a redelivered tool call cannot create a second proposal, and cannot apply twice. |
| `source_revision` | `document.current_revision` at proposal time. Feeds the stale/reconcile decision (FR-031) and is shown in the UI. |
| `summary` | Agent-authored one-line description; becomes the `revision.note` when applied. |
| `operations` | JSON array of `{ old_string, new_string }`. May span multiple disjoint document ranges within one proposal — accepted or dropped as a whole (FR-020; partial acceptance is out of scope). |
| `status` | `pending` (awaiting a verdict), `applied`, `dropped`, `superseded` (could not reconcile; a replacement was requested — FR-032). |
| `auto_applied` | `1` when the proposal came from the Primary conversation and was applied without staging (FR-027). Recorded so history can distinguish it, and so the Primary conflict path (FR-027 second half) is auditable. |
| `applied_revision` | The revision number created by applying it. Non-NULL ⟺ `status = 'applied'`. |
| `supersedes_id` | On a replacement proposal, points at the superseded original (FR-032), forming a chain if a replacement itself conflicts (spec edge case). |
| `replacement_attempt` | `0` on an originally-proposed edit; `predecessor.replacement_attempt + 1` on a replacement. A replacement is requested only while this would remain `<= max_replacement_attempts` (FR-032a). Storing the count rather than walking `supersedes_id` keeps the budget check a single read and makes the chain's remaining budget directly displayable. |
| `conflict_detail` | JSON describing why reconciliation failed — per-operation `{ index, reason: 'not_found' \| 'ambiguous' \| 'overlapping', occurrences }`. Sent to the agent when requesting a replacement, and shown to the user. |

**Validation rules**
- `operations` non-empty; every `old_string` non-empty.
- `replacement_attempt = 0` ⟺ `supersedes_id IS NULL`; otherwise `replacement_attempt = predecessor.replacement_attempt + 1` and never exceeds `max_replacement_attempts` (FR-032a).
- A conflict on a proposal already at `max_replacement_attempts` terminates the chain: the proposal stays `superseded`, no further replacement is requested, and the exhaustion is surfaced to the user (FR-032b).
- Only conversations with `branch_depth <= max_editing_depth` may create rows (FR-026).
- `status` transitions are one-way from `pending`; `applied`/`dropped`/`superseded` are terminal and set `resolved_at`.
- `status != 'pending'` ⇒ `resolved_at` non-NULL.

**State transitions**

```text
                     ┌──▶ applied      (reconciled cleanly; creates a revision)
  pending ───────────┼──▶ dropped      (user verdict, or "drop remaining")
                     └──▶ superseded ──▶ (new staged_edit with supersedes_id = this)
```

A Primary conversation's proposal is created and immediately reconciled: clean → `applied` with
`auto_applied = 1`; conflict → `superseded`, and the replacement arrives as an ordinary `pending`
proposal for user review (FR-027, FR-032). Non-Primary proposals are always created as `pending`
(FR-021).

### Reconciliation (the definition of "conflict")

Per research R4 — Automerge text merges never fail, so conflict is defined by anchor resolution
against the *current* document text:

| Condition for every operation | Outcome |
| --- | --- |
| `old_string` occurs exactly once, and no two resolved ranges overlap | **Clean** — apply all operations in one Automerge change (descending offset order), create a revision, mark `applied` |
| any `old_string` occurs 0 times | **Conflict** — `not_found` |
| any `old_string` occurs >1 times | **Conflict** — `ambiguous` |
| two resolved ranges overlap | **Conflict** — `overlapping` |

A conflict marks the proposal `superseded`, records `conflict_detail`, and asks the originating agent
for a replacement informed by that detail (FR-032). This is one code path for FR-025, FR-031 and
FR-032, and it makes SC-005 structural: an unresolvable anchor is never guessed at.

---

## 7. Conversation event

The application-level event stream: what the frontend renders from, and what a reconnecting client
replays (design §24, FR-037).

```sql
CREATE TABLE conversation_event (
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
);
```

| Field | Notes |
| --- | --- |
| `sequence` | Monotonic **per document**, not per conversation. A single ordering lets a reconnecting client say "send me everything after N" and receive a correctly interleaved catch-up across all conversations plus document-level events (FR-037, SC-006). |
| `conversation_id` | NULL for document-scoped events (`document_created`, `revision_created`, `primary_changed`). |
| `event_type` | See [contracts/websocket-events.md](./contracts/websocket-events.md) for the closed vocabulary. The same names are used as pino `event` field values (FR-042), so logs and the event stream share one taxonomy. |
| `data` | JSON payload, shape determined by `event_type` and validated by the shared Zod schema. |

Rows are append-only. High-frequency streaming deltas (`text_delta` / `thinking_delta`) are **not**
persisted here — they are broadcast live only; a reconnecting client receives the completed message
instead. Persisting per-token deltas would dominate the table for no recoverable value.

---

## 8. User settings

The single local user's configurable limits and preferences (FR-041). Singleton row.

```sql
CREATE TABLE user_settings (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),

    thinking_visible         INTEGER NOT NULL DEFAULT 0,
    revision_debounce_ms     INTEGER NOT NULL DEFAULT 300000,
    max_concurrent_agents    INTEGER NOT NULL DEFAULT 3,
    max_editing_depth        INTEGER NOT NULL DEFAULT 2,
    max_conversation_depth   INTEGER NOT NULL DEFAULT 3,
    max_replacement_attempts INTEGER NOT NULL DEFAULT 2,

    updated_at               TEXT NOT NULL
);
```

| Field | Default | Requirement |
| --- | --- | --- |
| `thinking_visible` | `0` (hidden) | FR-041, FR-010 |
| `revision_debounce_ms` | `300000` (5 min) | FR-004, FR-041 |
| `max_concurrent_agents` | `3` | FR-015, FR-041 |
| `max_editing_depth` | `2` | FR-026, FR-041 |
| `max_conversation_depth` | `3` | FR-013, FR-041 |
| `max_replacement_attempts` | `2` | FR-032a, FR-041 — replacement requests permitted per originating proposal, shared across its whole supersession chain |

**Validation rules**
- `revision_debounce_ms >= 1000`; the depth and concurrency limits are `>= 1`.
- `max_replacement_attempts >= 0`; `0` is meaningful and permitted — it disables automatic replacement entirely, so a conflicting proposal is superseded and reported to the user without the agent being asked again (FR-032a, FR-032b).
- `max_editing_depth` and `max_conversation_depth` are independent — the editing depth is deliberately
  *not* constrained to be ≤ conversation depth (design §10); a deep conversation may exist while only
  shallow ones may edit.
- Read server-side on every guarded operation, so a change takes effect immediately without restart
  (Principle V: limits are enforced where the mutation happens, not in the UI).

---

## Cross-entity invariants

These are the assertions integration tests should hold at all times:

1. **At most one Primary**: no more than one non-closed `conversation` per document has `is_primary = 1`, and zero is valid (FR-027, FR-027a). No closed conversation ever has `is_primary = 1` — closing the Primary clears the flag rather than transferring it.
2. **One Main**: exactly one `conversation` per document has `kind = 'main'`, and it is never closed (FR-009).
3. **No silent application**: every `revision` with `origin = 'agent_edit'` has a `staged_edit_id` whose row is `applied` — no document change of agent origin exists without a proposal record (SC-004, Principle III).
4. **Idempotency**: `(conversation_id, pi_tool_call_id)` is unique, so no tool call yields two proposals or two applications (FR-040).
5. **Append-only history**: `revision` rows are never updated or deleted; a restore adds a row (FR-006, Principle IV).
6. **Close safety**: no `conversation` with `status = 'closed'` has a `staged_edit` in `pending` (FR-033).
7. **Depth enforcement**: every `conversation` satisfies `branch_depth <= max_conversation_depth`, and every `staged_edit`'s conversation satisfies `branch_depth <= max_editing_depth` (FR-013, FR-026, Principle V).
8. **Revision continuity**: `revision` numbers per document are gapless from 1 to `document.current_revision`.
9. **Event ordering**: `conversation_event.sequence` is gapless per document, so replay-after-N is complete (FR-037).
10. **Bounded replacement**: no `staged_edit` has `replacement_attempt > max_replacement_attempts`, so every supersession chain terminates (FR-032a). A chain ends either in an `applied`/`dropped` proposal or in a `superseded` one at the cap.
