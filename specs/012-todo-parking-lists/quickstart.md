# Quickstart: Validating Todo & Parking Lot Lists

Prerequisites: repo installed (`npm install` at root), backend (port 3000) + frontend Vite dev
server (port 3001) runnable per the project's existing README instructions. No new environment
variables are required.

```bash
npm run dev            # backend
npm run dev:frontend    # frontend, separate terminal
```

Scope: validates User Stories 1–4 (FR-001 through FR-025). Run against one Canvas-mode document
and one Thread-mode document (spec 010's document-type picker) to cover both UI placements.

## Scenario 1 — Agent add/update/remove, user-request-gated (User Story 1/2, FR-003–FR-010)

1. Open a document, focus a conversation (Canvas) or send a message in a thread (Thread mode).
2. Ask the agent: "Add 'fix the intro paragraph' to the todo list." Confirm the agent calls
   `add_list_item` and confirms the addition in its reply.
3. Ask the agent to update that item's text; confirm it calls `list_items` first (or reuses the
   hash from step 2 if you ask immediately after), then `update_list_item`.
4. Ask the agent to remove it; confirm `remove_list_item` and the item disappearing.
5. Ask the agent an unrelated question in the same conversation (nothing about the lists); confirm
   in the activity log that it makes no `add_list_item`/`update_list_item`/`remove_list_item` calls
   on its own (FR-006, SC-006).
6. Repeat steps 2–4 against the Parking Lot list; confirm items never cross into the Todo list
   (FR-007's identifier scoping).

**Expected**: SC-002, SC-006.

## Scenario 2 — Stale-hash rejection (User Story 1 scenario 6, FR-008)

1. Ask the agent to add an item; note it now holds that item's hash.
2. Without telling the agent, edit that same item's text directly in the panel (User Story 4 path).
3. Ask the agent to update or remove that same item (referencing the text it still thinks is
   current). Confirm the tool call is rejected, the panel still shows your edited text unchanged,
   and the agent's reply reflects that current text (it should have been told the actual current
   value in the tool result).

**Expected**: SC-007 — zero silent overwrites.

## Scenario 3 — User CRUD via the panel (User Story 4, FR-011–FR-020)

1. Open the panel (see Scenario 4/5 for how, per mode) and add an item to each list via its
   `+ Add` control. Confirm each appears immediately with no reload.
2. Edit an item's text inline; confirm it updates immediately, with no confirmation step needed
   (FR-020 — never hash-gated).
3. Delete an item; confirm it disappears immediately.
4. Reload the page; confirm the panel (once reopened) shows exactly the items left after step 3.

**Expected**: SC-003, SC-005.

## Scenario 4 — Canvas mode placement and focus-gating (User Story 3, FR-021/FR-022)

1. Open a Canvas-mode document with no conversation focused. Confirm the `Lists` button in
   `.hud-bar-right` is visible but disabled, and clicking it does nothing.
2. Focus a conversation. Confirm the button becomes enabled; click it and confirm the rail appears
   attached to that conversation's detail overlay, listing both sections (FR-025).
3. Focus a second conversation (multi-focus). Confirm no second rail appears — the same single
   rail remains.
4. Un-focus every conversation (close all focused panels). Confirm the rail closes/disappears and
   the button returns to disabled, with no data loss (reopen a conversation and re-enable the
   button to confirm list contents are unchanged).

**Expected**: SC-008.

## Scenario 5 — Thread mode placement (User Story 3, FR-023/FR-024)

1. Open a Thread-mode document. Confirm the `Lists` button in `.thread-mode-hud`'s
   `.hud-bar-right` is enabled immediately, with no focus step required.
2. Click it; confirm a rail docks to the right edge of the viewport, outside
   `.thread-mode-content`, and the thread list narrows to make room rather than being covered.
3. Confirm every thread card and its composer remain fully usable at the narrower width.

**Expected**: SC-001, SC-009.

## Scenario 6 — Empty/whitespace rejection (Edge Cases, FR-017)

1. Via the panel, attempt to add an item with only spaces. Confirm it is rejected (no item
   created).
2. Ask the agent to add an item with empty text (or via a direct tool-call test if exercising this
   at the contract level). Confirm the same rejection.

**Expected**: SC-004 semantics extended to empty-text validation.
