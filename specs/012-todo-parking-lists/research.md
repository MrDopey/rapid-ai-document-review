# Phase 0 Research: Todo & Parking Lot Lists

## R1: Where list items live (storage shape)

**Decision**: A new normalized table, `list_item`, one row per item, with a `list` discriminator
column (`'todo' | 'parking_lot'`) — not a JSON blob column on `document`, and not two separate
tables.

**Rationale**: The codebase's existing convention (`document`, `revision`, `conversation`,
`staged_edit`, `conversation_event` — `app/backend/src/storage/sqlite/migrations.ts`) is one row
per entity, never a JSON blob for anything that's queried/mutated by id. Both lists share
identical shape and validation rules (FR-002, FR-015, FR-016), so one table with a `list` column
avoids duplicating the CRUD/service/tool-call code path for what would otherwise be two near-
identical tables. A JSON blob would force read-modify-write of the whole list on every single-item
mutation, which is exactly the kind of unguarded lost-update race FR-008's hash check exists to
prevent — a normalized table with per-row updates avoids that class of bug entirely rather than
re-introducing it at the JSON-blob level.

**Alternatives considered**:
- Two tables (`todo_item`, `parking_lot_item`): rejected — pure duplication, no behavioral
  difference between the two lists anywhere in the spec.
- JSON array column on `document`: rejected per Rationale above.

## R2: Concurrency-check mechanism (server-issued short hash)

**Decision**: `content_hash` is a short (10 hex characters) truncated SHA-256 of the item's `text`,
computed on demand server-side — never stored as a column — using Node's built-in `node:crypto`
(`createHash('sha256').update(text).digest('hex').slice(0, 10)`). No new dependency.

**Rationale**: Already decided during specification (spec.md FR-003/004/005/008/009, Assumptions).
`node:crypto` is already a transitive capability of the Node runtime this project targets (no new
package), and a truncated hex digest is a convenient, opaque, fixed-width string — cheap to pass as
a tool-call parameter and to compare server-side. Per spec.md's own assumption, this is explicitly
not a security/cryptographic control, just a stale-write detector, so SHA-256's cryptographic
properties are unused; a non-cryptographic hash (e.g. FNV-1a) would work equally well, but SHA-256
via `node:crypto` needs no new dependency and is simpler to get right than hand-rolling one.
Computing it on demand rather than persisting it (data-model.md) is a Phase-1-design refinement:
since it's a pure function of `text` alone, storing it would just be derived state that could drift
from `text` if any write path forgot to recompute it — deriving it on every read/compare removes
that failure mode for negligible extra CPU cost, given these lists' small expected size.

**Alternatives considered**:
- Full previous text as the "expected" tool-call parameter: rejected explicitly by the user during
  specification (this research item exists only to record the resulting hash algorithm choice).
- Automerge/CRDT-backed list items (Constitution Principle IV): rejected — Principle IV's CRDT
  mandate is scoped to *document content*; these lists are a separate sidecar entity (see
  Constitution Check note in plan.md), and a full CRDT is unwarranted complexity for a single
  scalar `text` field per row where "reject the stale writer" is a fully sufficient conflict policy
  per FR-008.
- Row-level `updated_at` timestamp comparison instead of a hash: rejected — a hash also changes
  when content is set back to an earlier value and changes deterministically only when content
  actually differs, whereas a timestamp requires wire-perfect clock/precision handling and doesn't
  let the agent's own error message quote back a stable, short identifier.

## R3: Real-time propagation to already-open frontends (SC-002)

**Decision**: Reuse the existing document-wide WebSocket event stream (`conversation_event` table,
`EventService.append`, `event-hub.ts` broadcast, `contracts/websocket-events.md`'s discriminated
union) rather than inventing a second channel. Three new event types: `list_item_added`,
`list_item_updated`, `list_item_removed`.

**Rationale**: Every other piece of document/conversation state (revisions, staged edits,
conversation status) already reaches connected clients through this one stream; list items are no
different in kind. Reusing it means the frontend's existing reconnect/replay-from-sequence logic
(websocket-events.md's "Handshake and replay") covers list items for free, and both the agent's
tool-call path and the user's HTTP path funnel through the same `ListItemService`, which is the one
place that calls `EventService.append` — so a change from either source reaches every open client
identically.

**Alternatives considered**: A dedicated polling endpoint — rejected, reinvents what the event
stream already solves, and would miss SC-002's "without requiring a manual page refresh" bar.

## R4: Constitution conflict — new agent tools

**Resolved via amendment (constitution v2.6.0, then v2.7.0)**: `Technology & Platform Constraints`
in `.specify/memory/constitution.md` lists "additional agent tools beyond document
read/edit/web-search/web-fetch" as an explicit v1 non-goal. This feature's FR-003/004/005/010
require four new tool calls (`add_list_item`, `update_list_item`, `remove_list_item`, and the
read-only `list_items`), which fell outside that allow-list as originally written.

The existing `web_search`/`web_fetch` carve-out (constitution v2.2.0–v2.4.0 history) is the
project's established mechanism for this exact situation: amend the non-goals bullet with a
specific, scoped carve-out, rather than waive it per-plan. That carve-out's rationale — "ordinary
`customTools`, no Pi extension required (Principle VII intact), doesn't touch the edit-proposal
pipeline (Principle III intact)" — extends cleanly to all four tools: they use the identical
`defineTool`/`customTools` registration mechanism (no Pi extension), and none of them ever touch
document content, so Principle III (proposals, not direct writes) is untouched by construction —
these tools mutate (or, for `list_items`, only read) a separate sidecar entity, not the document
Automerge state Principle III governs. `list_items` is additionally read-only, exactly like
`web_search`/`web_fetch`'s own carve-out rationale.

**Resolution**: the constitution was amended in two steps — v2.6.0 carved out the three mutating
tools (add/remove/update), and v2.7.0 extended that carve-out to also name the read-only
`list_items` tool explicitly (it was caught mid-plan as a genuine gap: the agent has no other way to
learn a pre-existing item's id/content-hash before calling `update_list_item`/`remove_list_item` on
it). Both amendments are committed. The Constitution Check in plan.md now reflects PASS for
Technology & Platform Constraints; no further amendment or waiver is required before
`/speckit-tasks`.

## R5: Frontend rail anchor differs by mode, same rail content

**Decision**: One shared `TodoParkingListsPanel.vue` component (rendering `.todo-list-section` and
`.parking-lot-section` as fixed sibling blocks, FR-024), mounted at two different anchor points:
- Canvas mode: inside `.conversation-detail-overlay`, alongside `<ConversationDetailPanel>`, gated
  on `orderedFocusedConversations.length > 0` (FR-021/FR-022).
- Thread mode: docked to the right edge of `.thread-mode-view`'s content region, outside
  `.thread-mode-content`, narrowing it via flex layout (FR-023/FR-024).

**Rationale**: Established during specification (spec.md's "UI Layout Reference" section) after
confirming Canvas mode has no equivalent of Thread mode's always-inline conversation list, and that
a full-panel modal wastes vertical space for two short string lists. Both anchor points are
existing, named structural elements already documented in `AGENTS.md`'s layout diagrams, so no new
top-level layout region is introduced — only a new leaf mounted into each mode's own existing
attachment point.

**Alternatives considered**: Documented and rejected during the specification conversation itself
(full-screen modal overlay; a popover anchored to the button without regard to conversation focus)
— see spec.md's "UI Layout Reference" section for the discussion trail.
