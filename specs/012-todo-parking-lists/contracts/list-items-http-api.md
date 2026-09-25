# Contract: HTTP API & Events — Todo & Parking Lot Lists

**Feature**: `012-todo-parking-lists` | **Related**: [../spec.md](../spec.md) (FR-011–FR-020),
[../data-model.md](../data-model.md), `specs/001-ai-document-review/contracts/http-api.md` and
`websocket-events.md` (base contracts this extends)

This is the frontend's own path for User Story 4 (manual CRUD via the panel) and for loading
initial state when the panel/rail is opened. It never carries or checks `contentHash` (FR-020) —
that check exists only on the agent tool-call path (`agent-tools-list-items.md`).

---

## `GET /api/documents/:documentId/list-items`

Returns both lists' current items. Called once when the panel/rail first becomes visible
(FR-012); subsequent changes arrive via the WebSocket events below, not repeated polling.

```json
{
  "todo": [{ "id": "li_...", "text": "...", "contentHash": "..." }],
  "parkingLot": [{ "id": "li_...", "text": "...", "contentHash": "..." }]
}
```

No `list` field per item — which list an item belongs to is the bucket key (`todo`/`parkingLot`)
itself; repeating it per item would be redundant (data-model.md's `ListItemDto` note).

Each list is ordered by append order (`createdAt`, `id` tiebreak) — no reordering support
(spec.md Assumptions).

## `POST /api/documents/:documentId/list-items`

```json
// request
{ "list": "todo" | "parking_lot", "text": "..." }
// response (201)
{ "id": "li_...", "text": "...", "contentHash": "..." }
```

The response echoes no `list` — the caller just supplied it in the request, so the client already
knows which list this item belongs to.

`400 VALIDATION_FAILED` if `text` is empty/whitespace-only after trim (FR-017).

## `PATCH /api/documents/:documentId/list-items/:itemId`

```json
// request
{ "text": "..." }
// response (200) — updated item, with a NEW contentHash (any agent hash held for this item is
// now stale, by design — FR-008/FR-020)
{ "id": "li_...", "text": "...", "contentHash": "..." }
```

`400 VALIDATION_FAILED` if `text` is empty/whitespace-only. `404 LIST_ITEM_NOT_FOUND` if `itemId`
doesn't exist for `documentId`. No hash is accepted or checked on this endpoint — a user's edit
always applies (FR-020).

## `DELETE /api/documents/:documentId/list-items/:itemId`

`204` on success. `404 LIST_ITEM_NOT_FOUND` if it doesn't exist. No hash accepted or checked.

## New error code (added to the shared error-code table in `http-api.md`)

| Code | Status | Raised by |
| --- | --- | --- |
| `LIST_ITEM_NOT_FOUND` | 404 | `PATCH`/`DELETE` on an unknown `itemId` |

(`add_list_item`/`update_list_item`/`remove_list_item`'s own "not found"/"stale hash" outcomes are
agent-tool-call `textResult` responses, per `agent-tools-list-items.md` — they are never HTTP error
codes, since the agent never calls this HTTP surface.)

---

## WebSocket events (new entries in the `ApplicationEvent` discriminated union, `events.ts`)

Reuses the exact envelope every other event uses (`contracts/websocket-events.md`'s "Frame
envelope"). `conversationId` is `null` when the change came from the HTTP path (a user's own
direct edit) and the acting conversation's id when it came from an agent tool call — the same
convention `staged_edit_created` already uses to distinguish origin.

```json
{ "type": "list_item_added",   "data": { "list": "todo", "item": { /* ListItemDto */ } } }
{ "type": "list_item_updated", "data": { "list": "todo", "item": { /* ListItemDto */ } } }
{ "type": "list_item_removed", "data": { "list": "todo", "itemId": "li_..." } }
```

All three are non-ephemeral (unlike `text_delta` etc.) — they carry a real `sequence` and are
replayed to a reconnecting client exactly like `revision_created`/`staged_edit_created`, satisfying
FR-018's "persist... across reloads" together with the `GET` endpoint above (`GET` gives the
snapshot on first load; these events keep it live and cover reconnect-replay).

Both the agent tool-call path (`ListItemService`, invoked from `pi/tools/list-items.ts`) and this
HTTP path funnel through the identical `ListItemService` methods, so exactly one code path ever
calls `EventService.append` for a list-item change — a change from either origin reaches every
open client identically (research.md R3).
