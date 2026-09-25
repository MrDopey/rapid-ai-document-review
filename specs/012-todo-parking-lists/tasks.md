---

description: "Task list template for feature implementation"
---

# Tasks: Todo & Parking Lot Lists

**Input**: Design documents from `/workspaces/rapid-ai-document-review/specs/012-todo-parking-lists/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Not explicitly requested for this feature. Test tasks below are limited to the specific unit/contract/component test files plan.md's own Project Structure already calls out as deliverables; no separate TDD "write-first" phase is included.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P4) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US4)

## Path Conventions

Web app (existing `app/backend` + `app/frontend` + `app/shared` npm workspaces, per plan.md's Structure Decision) — no new top-level project or workspace.

---

## Phase 1: Setup

**Purpose**: Confirm a clean starting point. No new dependencies or tooling are needed for this feature (research.md R1/R2: `node:sqlite`/`node:crypto` are already available in the Node ≥26.1.0 runtime this project targets).

- [X] T001 Run `npm run lint && npm run format && npm test` (backend) from the repo root and confirm a clean, green baseline before making any changes for this feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Storage, hash computation, and the shared `ListItemService` that BOTH the agent tool-call path (US1/US2) and the HTTP path (US4) depend on. US3 (visibility/placement) only needs the shared contract types from this phase.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 [P] Add the `list_item` table to `app/backend/src/storage/sqlite/migrations.ts`: `CREATE TABLE IF NOT EXISTS list_item (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, list TEXT NOT NULL CHECK (list IN ('todo', 'parking_lot')), text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (document_id) REFERENCES document(id))` plus `CREATE INDEX IF NOT EXISTS list_item_document_list ON list_item (document_id, list, created_at)`, and bump the migration version (data-model.md's SQLite DDL — note there is deliberately no `content_hash` column)
- [X] T003 [P] Add the `ListItemRow` interface (`id: string`, `documentId: string`, `list: 'todo' | 'parking_lot'`, `text: string`, `createdAt: string`, `updatedAt: string` — no hash field) and the five new method signatures (`createListItem`, `getListItem`, `listListItems`, `updateListItemText`, `deleteListItem`) to the `StorageAdapter` interface in `app/backend/src/storage/storage-adapter.ts` (data-model.md's StorageAdapter additions)
- [X] T004 Implement `createListItem`, `getListItem`, `listListItems` (both lists, ordered by `list` then `created_at`/`id`), `updateListItemText`, and `deleteListItem` (hard delete, no soft-delete/tombstone) on `SqliteStorageAdapter` in `app/backend/src/storage/sqlite/index.ts` (depends on T002, T003)
- [X] T005 [P] Implement `computeContentHash(text: string): string` — a truncated (10 hex character) SHA-256 of `text` via `node:crypto` (`createHash('sha256').update(text).digest('hex').slice(0, 10)`), in `app/backend/src/list-items/content-hash.ts` (research.md R2), plus a unit test in `app/backend/tests/unit/content-hash.test.ts` covering: same input → same hash; different input → different hash (not a security control, just a stale-write detector)
- [X] T006 Implement `ListItemService` in `app/backend/src/list-items/list-item-service.ts` with `addItem`, `updateItem`, `removeItem`, and `listItems`: `text` MUST be rejected (no item created/changed) when empty or whitespace-only after trimming (FR-017, applies to both the agent path and the user path); `updateItem`/`removeItem` MUST reject (leaving the item unchanged) when the caller's `expectedContentHash` doesn't equal `computeContentHash` of the row's current `text` (FR-008), returning the row's actual current `text` and freshly computed `contentHash` in that rejection; every successful mutation calls `EventService.append` to emit `list_item_added`/`list_item_updated`/`list_item_removed` (research.md R3) — this is the single code path both the agent tool-call path and the HTTP path funnel through (depends on T004, T005); unit tests in `app/backend/tests/unit/list-item-service.test.ts` covering add/update/remove/list, the empty-text rejection, and the stale-hash rejection
- [X] T007 [P] Add `ListItemDto` (`id: string`, `text: string`, `contentHash: string` — no `list`, `documentId`, `createdAt`, or `updatedAt` fields, per data-model.md's DTO note) and the list-items HTTP request/response schemas to `app/shared/src/contracts/http.ts`
- [X] T008 [P] Add `list_item_added` (`{ list, item: ListItemDto }`), `list_item_updated` (`{ list, item: ListItemDto }`), and `list_item_removed` (`{ list, itemId: string }`) to the `ApplicationEvent` discriminated union in `app/shared/src/contracts/events.ts`, using the existing event envelope (`contracts/list-items-http-api.md`'s WebSocket events section)

**Checkpoint**: Storage, hash computation, and `ListItemService` are ready — every user story below builds on this.

---

## Phase 3: User Story 1 - User asks the agent to manage the Todo list (Priority: P1) 🎯 MVP

**Goal**: The agent can add, update, and remove Todo-list items via tool calls — but only in direct response to an explicit user request, never on its own initiative, and never overwriting an item the user changed after the agent last saw it.

**Independent Test**: With the user explicitly instructing the agent in conversation, have the agent call the add/update/remove tool calls against the Todo list and confirm the list reflects only the requested items, edits, and removals — and that the agent does not add or change items unprompted (spec.md US1 Independent Test).

### Implementation for User Story 1

- [X] T009 [P] [US1] Add Zod schemas for the four tool calls' parameters — `list_items` (no params), `add_list_item` (`{ list, text }`), `update_list_item` (`{ list, id, expected_content_hash, text }`), `remove_list_item` (`{ list, id, expected_content_hash }`) — and the shared `listItemToolResult` (`{ id: string, list: 'todo' | 'parking_lot', contentHash: string | undefined }`, `contentHash` absent on `remove_list_item` success) to `app/shared/src/contracts/agent-tools.ts` (contracts/agent-tools-list-items.md)
- [X] T010 [US1] Implement the four tool factories in `app/backend/src/pi/tools/list-items.ts`, each registered via `defineTool`/`customTools` (no Pi extension, Principle VII): `list_items` read-only, exempt from the "explicit user request" gating below; `add_list_item`, `update_list_item`, `remove_list_item` whose model-facing `description`s explicitly state the agent MUST only call them "ONLY when the user explicitly asks" (FR-006) and MUST NOT use either list as its own task list or memory; `update_list_item`/`remove_list_item` MUST document that `expected_content_hash` is the hash of the item's *current* text, never the hash of new text being sent (contracts/agent-tools-list-items.md) (depends on T006, T009)
- [X] T011 [US1] Export the four new tool factories from `app/backend/src/pi/tools/index.ts` and register them in the `customTools` array in `app/backend/src/pi/pi-service.ts` (depends on T010)
- [X] T012 [US1] Add integration test scenarios (fake-agent-session) in `app/backend/tests/integration/` covering, against the Todo list: add → update → remove round trip; not-found error when `id` doesn't exist on the list, leaving both lists unchanged (FR-007); stale-hash rejection when a panel edit changes an item's text before the agent's `update_list_item`/`remove_list_item` call arrives, confirming the item keeps the user's value and the rejection reports the item's actual current text (FR-008, spec.md US1 acceptance scenario 6); the agent makes zero `add_list_item`/`update_list_item`/`remove_list_item` calls during a conversation where the user never mentions the lists (FR-006, SC-006) (depends on T011)

**Checkpoint**: User Story 1 is fully functional and independently testable — the agent can manage the Todo list end-to-end via tool calls.

---

## Phase 4: User Story 2 - User asks the agent to manage the Parking Lot list (Priority: P2)

**Goal**: The same agent tool calls manage the Parking Lot list, independently of the Todo list, with the same user-request-only and stale-hash-rejection behavior.

**Independent Test**: With the user explicitly instructing the agent in conversation, have the agent call the add/update/remove tool calls against the Parking Lot list and confirm items land there and not on the Todo list, and that the agent never acts on this list unprompted (spec.md US2 Independent Test).

### Implementation for User Story 2

- [X] T013 [US2] Add integration test scenarios in `app/backend/tests/integration/` confirming the same four tool calls (T010/T011) operate identically against `list: "parking_lot"`: add/update/remove land only on the Parking Lot list, never the Todo list; an id from one list is never resolved against the other (FR-007's per-list scoping); the agent makes zero Parking Lot tool calls when unprompted (spec.md US2 acceptance scenarios). No new production code — this phase validates the generic, already-shared implementation from Phase 3 against the second list value (depends on T011)

**Checkpoint**: User Stories 1 AND 2 are both independently functional.

---

## Phase 5: User Story 3 - User shows or hides the lists panel (Priority: P3)

**Goal**: A `[Lists (n)]` control in `.hud-bar-right` toggles a shared panel/rail. In Canvas mode it's disabled until a conversation is focused, then attaches as a single shared rail to `.conversation-detail-overlay` (never one rail per focused conversation). In Thread mode it's always enabled and docks as a fixed rail hugging the right edge, outside `.thread-mode-content`, narrowing rather than covering the thread list.

**Independent Test**: Click the toggle control in `.hud-bar-right` and confirm the panel shows/hides with contents preserved; confirm the control's enabled/disabled state matches conversation-focus state in Canvas mode, and is always enabled in Thread mode (spec.md US3 Independent Test).

### Implementation for User Story 3

- [X] T014 [P] [US3] Create the `listItems` Pinia store in `app/frontend/src/stores/listItems.ts`: `todo`/`parkingLot` item arrays, a `fetchListItems(documentId)` action calling `GET /api/documents/:documentId/list-items`, and WebSocket handlers for `list_item_added`/`list_item_updated`/`list_item_removed` that route into the correct array using the event's own `data.list` (FR-018's "persist... across reloads" is satisfied by this GET snapshot plus event replay); unit tests in `app/frontend/tests/unit/listItems.store.spec.ts` (depends on T007, T008)
- [X] T015 [P] [US3] Create `app/frontend/src/components/TodoParkingListsPanel.vue`: renders a `.todo-list-section` and a `.parking-lot-section` as two always-visible, vertically stacked sibling blocks (FR-025, never independently collapsible), reading from the `listItems` store; render `text` via plain interpolation only (never `v-html`/innerHTML — Constitution Principle VI, plan.md Constitution Check) since list items are plain text, not Markdown. Read-only in this phase (add/edit/delete controls come in User Story 4). Component test in `app/frontend/tests/component/todoParkingListsPanel.spec.ts` (depends on T014)
- [X] T016 [P] [US3] In `app/frontend/src/App.vue` (Canvas mode): add a `[Lists (n)]` control to `.hud-bar-right`/`.actions-group`, disabled whenever no conversation is currently focused and enabled as soon as at least one is (FR-021); when enabled and toggled, mount exactly one `<TodoParkingListsPanel>` instance as a rail attached to `.conversation-detail-overlay` — never one rail per focused conversation, regardless of how many are simultaneously focused (FR-022) (depends on T015)
- [X] T017 [P] [US3] In `app/frontend/src/components/thread/ThreadModeView.vue` (Thread mode): add a `[Lists (n)]` control to `.thread-mode-hud`'s `.hud-bar-right`/`.actions-group`, always enabled regardless of any conversation-focus state (FR-023); when toggled, mount `<TodoParkingListsPanel>` as a fixed rail hugging the right edge of the viewport, outside `.thread-mode-content`, narrowing that content area's available width via flex layout rather than overlapping or covering it (FR-024) (depends on T015)
- [X] T018 [US3] Manual browser verification per `AGENTS.md`'s "Frontend UI verification" (vitest/jsdom has missed real layout/focus bugs before — don't trust it alone here): with the dev server running, confirm the Canvas-mode toggle's disabled→enabled transition on focusing a conversation, that focusing a second conversation never spawns a second rail, and that the Thread-mode rail narrows the thread list without ever clipping a thread card or its composer (spec.md SC-008/SC-009) — report repro steps to the user rather than claiming success without this manual pass (depends on T016, T017)

**Checkpoint**: User Stories 1, 2, and 3 are all independently functional — the panel is visible and correctly placed in both modes (contents still read-only).

---

## Phase 6: User Story 4 - User manages list items directly (Priority: P4)

**Goal**: The user can add, edit, and delete items on either list directly from the panel, via ordinary HTTP CRUD with no hash gating — those edits always apply immediately, and immediately invalidate any hash the agent may be holding for that item.

**Independent Test**: With the panel open, add, edit, and delete an item on each list directly in the UI and confirm the changes are reflected immediately and persist after closing and reopening the panel (spec.md US4 Independent Test).

### Implementation for User Story 4

- [X] T019 [P] [US4] Implement `GET`, `POST`, `PATCH`, `DELETE` routes for `/api/documents/:documentId/list-items(/:itemId)` in `app/backend/src/api/http/list-items.ts`, calling `ListItemService` directly with no `expected_content_hash` accepted or checked on this path (FR-020 — a user's edit/delete always applies immediately); `400 VALIDATION_FAILED` when `text` is empty/whitespace-only after trim (FR-017); `404 LIST_ITEM_NOT_FOUND` when `PATCH`/`DELETE` target an unknown `itemId` (contracts/list-items-http-api.md) (depends on T006, T007)
- [X] T020 [US4] Add contract test cases for the four endpoints (success responses, `400 VALIDATION_FAILED`, `404 LIST_ITEM_NOT_FOUND`) in `app/backend/tests/contract/http.test.ts` (depends on T019)
- [X] T021 [P] [US4] Add add/edit/delete controls to `TodoParkingListsPanel.vue`'s `.todo-list-section`/`.parking-lot-section` (a `+ Add` input per section, inline text edit, a delete action per item), wired to the `listItems` store's HTTP calls (`POST`/`PATCH`/`DELETE`); edits and deletes apply immediately with no confirmation step and no hash involved (FR-020) (depends on T014, T015)
- [X] T022 [US4] Manual browser verification: add, edit, and delete a Todo item and a Parking Lot item via the panel in both a Canvas-mode and a Thread-mode document; reload the page and confirm the panel (once reopened) shows exactly the items left afterward, unchanged (FR-018, quickstart.md Scenario 3) (depends on T019, T021)

**Checkpoint**: All four user stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final compliance and validation passes across the whole feature.

- [X] T023 [P] Review every code comment added or changed in this feature's diff against Constitution Principle VIII (durable, not historical — no comment narrating this task/change or referencing FR-IDs/ticket numbers)
- [X] T024 Run all 6 scenarios in `specs/012-todo-parking-lists/quickstart.md` end-to-end (both a Canvas-mode and a Thread-mode document) and fix any failures
- [X] T025 Run `npm run lint && npm run format && npm test` from the repo root, plus `npm run test:unit --workspace=app/frontend` and `npm run test:component --workspace=app/frontend`, and fix any failures until everything exits green

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational only.
- **User Story 2 (Phase 4)**: Depends on Foundational + Phase 3 (T011) — reuses US1's tool implementation entirely; adds no new production code.
- **User Story 3 (Phase 5)**: Depends on Foundational only (T007/T008) — independent of US1/US2's agent-tool work.
- **User Story 4 (Phase 6)**: Depends on Foundational (T006/T007) and on US3's store/panel (T014/T015) for its frontend controls.
- **Polish (Phase 7)**: Depends on all four user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: No dependencies on other stories.
- **User Story 2 (P2)**: Test-only phase verifying US1's shared implementation against the second list value; not independently implementable without US1's tools existing, but adds no coupling of its own.
- **User Story 3 (P3)**: No dependencies on US1/US2 — independent of the agent tool-call path entirely.
- **User Story 4 (P4)**: Depends on US3's store/panel component (T014/T015) for its frontend controls; its backend HTTP routes (T019) depend only on Foundational.

### Parallel Opportunities

- T002, T003, T005, T007, T008 (Foundational) can all run in parallel — different files, no cross-dependencies.
- T009 (US1) can run in parallel with any remaining Foundational `[P]` work once T006 lands.
- T014 and T015 (US3) can be developed in parallel with T019 (US4's backend routes) — different files/layers.
- T016 and T017 (US3) can run in parallel — different files (`App.vue` vs `ThreadModeView.vue`), same dependency (T015).
- T021 (US4's panel controls) can run in parallel with T019/T020 (US4's backend routes) — different files.

---

## Parallel Example: Foundational Phase

```bash
# Launch independent Foundational tasks together:
Task: "Add list_item table + index to app/backend/src/storage/sqlite/migrations.ts"
Task: "Add ListItemRow interface + method signatures to app/backend/src/storage/storage-adapter.ts"
Task: "Implement computeContentHash in app/backend/src/list-items/content-hash.ts"
Task: "Add ListItemDto + HTTP schemas to app/shared/src/contracts/http.ts"
Task: "Add list_item_added/updated/removed event types to app/shared/src/contracts/events.ts"
```

## Parallel Example: User Story 3

```bash
Task: "Create listItems Pinia store in app/frontend/src/stores/listItems.ts"
Task: "Create TodoParkingListsPanel.vue in app/frontend/src/components/"
# then, once the panel exists:
Task: "Wire Lists toggle + rail into App.vue (Canvas mode)"
Task: "Wire Lists toggle + rail into ThreadModeView.vue (Thread mode)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1 — agent can manage the Todo list via tool calls
4. **STOP and VALIDATE**: run Phase 3's integration tests and confirm US1's Independent Test passes
5. Demo if ready — note the panel doesn't exist yet at this point (US3), so this MVP is agent-only

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add User Story 1 → agent manages the Todo list (MVP)
3. Add User Story 2 → agent manages the Parking Lot list too (test-only increment)
4. Add User Story 3 → panel becomes visible/placed correctly in both modes (read-only)
5. Add User Story 4 → user gains full manual CRUD via the panel
6. Polish → constitution/comment review, quickstart validation, full green test run

### Parallel Team Strategy

With multiple developers, once Foundational (Phase 2) is done:
- Developer A: User Story 1 → User Story 2 (backend/agent-tools track)
- Developer B: User Story 3 → User Story 4 (frontend/HTTP track)

These two tracks only meet at User Story 4's panel controls (T021), which need US3's store/panel (T014/T015) to already exist.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- User Story 2 and parts of Phase 7 add no new production code — they validate the shared implementation from earlier phases
- Constitution Check (plan.md) passes as amended (v2.6.0/v2.7.0) — no outstanding governance blockers for this task list
- Verify tests fail before implementing, where a test task is listed
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently
