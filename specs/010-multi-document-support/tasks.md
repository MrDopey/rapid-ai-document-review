# Tasks: Multi-Document Support

**Input**: Design documents from `/specs/010-multi-document-support/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: Not explicitly requested as TDD in the spec, and no prior feature in this repo (e.g.
009-agent-activity-logging) added a separate optional TDD section either. This feature changes
behavior asserted by many existing tests (the storage/service/route layer's singleton-document
assumption), so updating those existing tests, and adding new isolation/regression tests, is
included as required implementation work within each phase — not as a separate optional section.

**Organization**: Tasks are grouped by user story (spec.md: US1 & US2 are P1, US3 is P2) so each
story is independently implementable and testable, on top of a shared Foundational phase that
removes the codebase's "exactly one document" assumption.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1, US2, or US3, per spec.md
- File paths are exact, repo-root-relative

---

## Phase 1: Setup

**Purpose**: Confirm the working environment; no new dependencies are needed — every change below
modifies existing modules in `app/backend`, `app/shared`, and `app/frontend`.

- [X] T001 Confirm `git status` is clean and you're on (or have created) branch
  `010-multi-document-support`; confirm `npm run dev` (backend) and `npm run dev:frontend` start
  cleanly against the current single-document data — no code changes in this task.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Remove the three concentrated singleton-document access points identified in
research.md (R1) — `StorageAdapter.getDocument()`, the single in-memory `AutomergeStoreHolder`,
and document-id-free HTTP/WS routes — and thread `documentId` through every service call site that
currently relies on the implicit singleton. **No user story can be implemented or tested until this
phase is complete**, since today there is no way to have more than one document at all.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Storage layer

- [X] T002 In `app/backend/src/storage/sqlite/migrations.ts`, add a new `version: 3` entry to the
  `MIGRATIONS` array (after the existing `version: 2` entry, ~line 187) using the existing
  `addColumn` helper (~line 210, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`) to add
  `last_active_at TEXT NOT NULL DEFAULT ''` to the `document` table (defined ~lines 7-14). Per
  data-model.md's `Document.lastActiveAt` field: "When this document was last the active document
  for the user. Drives the dropdown's most-recently-active ordering ... and 'restore the document
  active at shutdown' behavior (FR-011)." Backfill existing rows' `last_active_at` to their
  `updated_at` value as part of the same migration's `apply` function (single-document installs get
  one dropdown entry, correctly ordered).
- [X] T003 In `app/backend/src/storage/storage-adapter.ts`, change the `StorageAdapter` interface:
  replace `getDocument(): DocumentRow | null` with `getDocument(documentId: string): DocumentRow |
  null`, and add `listDocuments(): DocumentRow[]` (ordered by `last_active_at` descending, per
  data-model.md's Document Summary derivation), `deleteDocument(documentId: string): void`,
  `renameDocument(documentId: string, title: string): DocumentRow`, and
  `touchLastActive(documentId: string): void`.
- [X] T004 In `app/backend/src/storage/sqlite/index.ts`, update `SqliteStorageAdapter.getDocument()`
  (~line 223) to take and filter by `documentId`, and implement the four new methods from T003:
  `listDocuments()` (`SELECT * FROM document ORDER BY last_active_at DESC`), `deleteDocument()`
  (delete the `document` row; rely on existing `document_id` foreign keys on `revision`,
  `document_snapshot`, `document_change`, `conversation`, `staged_edit`, `conversation_event` — add
  explicit cascading deletes for each of those six tables in the same transaction, since the schema
  does not declare `ON DELETE CASCADE`), `renameDocument()` (`UPDATE document SET title = ?,
  updated_at = ? WHERE id = ?`), and `touchLastActive()` (`UPDATE document SET last_active_at = ?
  WHERE id = ?`).
- [X] T005 [P] In `app/backend/src/storage/sqlite/index.ts`, update `mapDocument()` (~line 40) to
  include `lastActiveAt` in the returned `DocumentRow`, and update the `DocumentRow`/`DocumentDbRow`
  type definitions in `app/backend/src/storage/storage-adapter.ts` accordingly.

### In-memory Automerge store

- [X] T006 Rewrite `app/backend/src/document/automerge-store-holder.ts`: replace the single
  `private store: AutomergeStore | null` field with `private stores = new Map<string,
  AutomergeStore>()`. Change `get(): AutomergeStore` to `get(documentId: string): AutomergeStore`
  (throw the existing "Document not created yet" error if absent), `isSet(): boolean` to
  `isSet(documentId: string): boolean`, `set(store: AutomergeStore): void` to `set(documentId:
  string, store: AutomergeStore): void`, and add `delete(documentId: string): void` (called on
  document deletion, per research.md R2: "evicted on delete").

### Document/Revision/Conversation/Edit services

- [X] T007 In `app/backend/src/document/document-service.ts`: change `loadIfExists()` (~lines
  150-168) to `loadAllExisting()`, iterating `this.storage.listDocuments()` and calling
  `this.automerge.set(doc.id, AutomergeStore.load(this.storage, doc.id))` for each row (was a single
  `this.storage.getDocument()` call at ~line 151). Update the call site in `server.ts` accordingly.
- [X] T008 In `app/backend/src/document/document-service.ts`, remove the `DocumentAlreadyExistsError`
  guard in `create()` (~lines 170-173, `if (this.storage.getDocument()) { throw new
  DocumentAlreadyExistsError(...) }`) — per data-model.md, this guard *was* the singleton
  enforcement and FR-009's "can't delete the last document" is now the only remaining cardinality
  floor. Every other method on `DocumentService` that calls `this.storage.getDocument()` with no
  argument (`get()`, `applyChanges()`, etc.) must take a `documentId` parameter and pass it through.
  Add `listDocuments(): DocumentSummary[]` (maps `storage.listDocuments()` rows to `{ id, title,
  isActive, lastActiveAt }`, with `isActive` resolved against a caller-supplied active id),
  `renameDocument(documentId: string, title: string)`, `setActive(documentId: string)` (calls
  `storage.touchLastActive`), and `deleteDocument(documentId: string)` (rejects with a new
  `LastDocumentError` if `storage.listDocuments().length === 1`, per FR-009; otherwise calls
  `storage.deleteDocument` and `automerge.delete`).
- [X] T009 [P] In `app/backend/src/document/revision-service.ts`, thread `documentId` through every
  method that currently calls `this.storage.getDocument()` with no argument (mirrors T008's pattern
  for `DocumentService`).
- [X] T010 [P] In `app/backend/src/conversation/conversation-service.ts`, add a `documentId`
  parameter to every public method (`send` ~line 727, `refreshAndSend` ~line 800, `retry` ~line 852,
  and the others) and change all 8 call sites of `this.storage.getDocument()` (currently at ~lines
  174, 262, 280, 305, 360, 565, 718, 815) to `this.storage.getDocument(documentId)`.
- [X] T011 [P] In `app/backend/src/edit/edit-service.ts`, add a `documentId` parameter to every
  public method and change both call sites of `this.storage.getDocument()` (~lines 321, 374) to
  `this.storage.getDocument(documentId)`.

### HTTP contracts and routes

- [X] T012 In `app/shared/src/contracts/http.ts`, add `DocumentSummaryDto` (`{ id: z.string(), title:
  z.string(), isActive: z.boolean(), lastActiveAt: z.string() }`), `ListDocumentsResponse` (`{
  documents: z.array(DocumentSummaryDto) }`), `RenameDocumentRequest` (`{ title: z.string().min(1)
  }`), and `DeleteDocumentResponse` (`{ id: z.string() }`), per contracts/http-and-ws.md. Add
  `'LAST_DOCUMENT'` to the existing `ErrorCode` enum (~line 35).
- [X] T013 In `app/backend/src/api/http/document.ts`, per contracts/http-and-ws.md's route table:
  rename `POST /api/document` → `POST /api/documents` (drop the `DocumentAlreadyExistsError` catch,
  since T008 removed that error); add `GET /api/documents` (list, using `documentService.
  listDocuments()`, returning `ListDocumentsResponse`); change `GET /api/document` → `GET
  /api/documents/:documentId`; change `PATCH /api/document` → `PATCH /api/documents/:documentId`
  (also accepting `RenameDocumentRequest`'s `title`-only shape, dispatching to
  `documentService.renameDocument`); add `DELETE /api/documents/:documentId` (catching the new
  `LastDocumentError` from T008 as `409` / `LAST_DOCUMENT`); change `GET /api/document/export` → `GET
  /api/documents/:documentId/export`.
- [X] T014 [P] In `app/backend/src/api/http/revisions.ts`, change `GET /api/revisions` → `GET
  /api/documents/:documentId/revisions` and `POST /api/revisions/:revision/restore` → `POST
  /api/documents/:documentId/revisions/:revision/restore`, replacing each `storage.getDocument()`
  call (currently ~lines 31, 53, both parameterless) with `storage.getDocument(request.params.
  documentId)`.
- [X] T015 [P] In `app/backend/src/api/http/conversations.ts`, nest every route under
  `/api/documents/:documentId/conversations...` per contracts/http-and-ws.md (currently `/api/
  conversations` at ~line 118 and `/api/conversations/:id` + its 8 action sub-routes at ~lines
  128-216), threading `request.params.documentId` into each `conversationService` call added by
  T010.
- [X] T016 [P] In `app/backend/src/api/http/edits.ts`, nest every route under `/api/documents/
  :documentId/...` per contracts/http-and-ws.md (currently `/api/conversations/:id/edits` at ~line
  21 and the four `/api/edits/:id/...` routes at ~lines 28-74), threading `request.params.documentId`
  into each `editService` call added by T011.

### WebSocket

- [X] T017 In `app/shared/src/contracts/events.ts`, add a required `documentId: z.string()` field to
  `SubscribeFrame` (~line 329).
- [X] T018 In `app/backend/src/api/ws/index.ts`, replace the singleton lookup at ~lines 40-42 (`const
  doc = storage.getDocument(); if (!doc) return; eventHub.subscribe(socket, doc.id, frame.data.
  sinceSequence);`) with `eventHub.subscribe(socket, frame.data.documentId, frame.data.
  sinceSequence)` after validating `storage.getDocument(frame.data.documentId)` exists (send a
  `not_found`-style closed frame otherwise, per contracts/http-and-ws.md's "unknown id yields the
  existing not-found error envelope shape"). `EventHub.subscribe` (`app/backend/src/events/
  event-hub.ts:96`) already takes `documentId` as a parameter — no change needed there.

### Frontend plumbing

- [X] T019 In `app/frontend/src/stores/document.ts`, add an `activeDocumentId` piece of state and a
  `documents: DocumentSummaryDto[]` list (populated from the new `GET /api/documents`), plus actions
  `switchTo(documentId)`, `createNew()`, `rename(documentId, title)`, and `remove(documentId)` that
  call the T013 routes and update `activeDocumentId`/`documents` accordingly.
- [X] T020 In `app/frontend/src/transport/ws-client.ts`, add `activeDocumentId` to the subscribe
  frame sent at ~line 67 (`socket.send(JSON.stringify({ type: 'subscribe', documentId:
  this.activeDocumentId, sinceSequence: this.getSinceSequence() }))`), and expose a method to
  re-subscribe (send a fresh `subscribe` frame on the existing connection, per contracts/
  http-and-ws.md: "re-subscribes the existing WebSocket connection to the newly active documentId
  rather than opening a second connection") when the store's `activeDocumentId` changes.

**Checkpoint**: The backend can now hold and serve more than one document, every route/event is
explicitly document-scoped, and the frontend has a place to track which document is active. No UI
exists yet — user story implementation can now begin.

---

## Phase 3: User Story 1 - Create and switch between multiple documents (Priority: P1) 🎯 MVP

**Goal**: A title-bar dropdown lets the user create a new document, see every open document, and
switch the active one — with the full workspace (editor, preview, conversation sidebar, HUD)
swapping to match, plus a keyboard shortcut that does the same without the dropdown.

**Independent Test**: From an existing document, create a new document via the dropdown, type
distinct content into it, switch back to the original via the dropdown, confirm its content is
unchanged, then switch using `Ctrl+Alt+[`/`Ctrl+Alt+]` and confirm identical behavior — per
spec.md US1 Acceptance Scenarios 1-5.

### Implementation for User Story 1

- [X] T021 [US1] Create `app/frontend/src/components/header/DocumentSwitcherDropdown.vue`: renders
  the active document's title (replacing the static `<h1 class="document-title-text">` in
  `App.vue`, ~line 712) as a button that opens a dropdown listing `store.documents` (most-recently-
  active first, per data-model.md's Document Summary), marking the active one, with a "+ New
  document" row at the bottom (FR-001) and, per spec.md's title-bar-dropdown mockup, a rename affordance
  and a delete affordance (delete wired in Phase 5/US3, but the row/menu structure is built here so
  US3 only adds handlers).
- [X] T022 [US1] In `app/frontend/src/App.vue`, replace the static title markup (~lines 710-713)
  with `<DocumentSwitcherDropdown />`, and on mount call `store.document`'s new `documents`-loading
  action (T019) so the dropdown has data before it's first opened.
- [X] T023 [US1] Wire `DocumentSwitcherDropdown`'s "+ New document" action to `store.createNew()`
  (T019), which `POST`s to `/api/documents` (T013) and then calls `switchTo()` with the new id —
  satisfying FR-001 and US1 Acceptance Scenario 1.
- [X] T024 [US1] Wire `DocumentSwitcherDropdown`'s row-click to `store.switchTo(documentId)` (T019),
  which must trigger: (a) re-fetching the target document's `DocumentDto`/content, (b) the
  ws-client re-subscribe from T020, (c) reloading the conversation HUD/sidebar and revision-history
  panel for the new active document — satisfying FR-003 and US1 Acceptance Scenario 3. Confirm the
  previously active document's in-progress editor state (unsaved keystrokes already autosaved per
  spec 001's debounce) is not touched by this switch, satisfying US1 Acceptance Scenario 4.
- [X] T025 [US1] In `app/frontend/src/a11y/keymap-registry.ts`, add two entries to `HOTKEY_BINDINGS`
  (~after line 389, alongside the other `Global`-scope bindings): `{ id: 'switch-document-next',
  modifiers: { ctrl: true, alt: true, shift: false }, code: 'BracketRight', scope: 'Global',
  description: 'Switch to the next open document.' }` and `{ id: 'switch-document-prev', modifiers:
  { ctrl: true, alt: true, shift: false }, code: 'BracketLeft', scope: 'Global', description:
  'Switch to the previous open document.' }`, matching research.md R4's chosen combo. Also add both
  to `KEYBOARD_SHORTCUTS` for the help dialog.
- [X] T026 [US1] In `app/frontend/src/App.vue`, add `switch-document-next`/`switch-document-prev` to
  the `GLOBAL_BINDINGS`-derived handler map (~near line 486) so `onGlobalKeydown` cycles
  `store.documents` (wrap-around) and calls `store.switchTo()` on the resulting id — a no-op when
  only one document exists (spec.md Edge Cases), and functional whether or not the dropdown is
  currently open (spec.md Edge Cases) — satisfying FR-003a and US1 Acceptance Scenario 5.
- [X] T027 [US1] Run `npx vitest run tests/unit/keymap-registry.spec.ts --config app/frontend/
  vitest.config.ts` (or the project's standard `npm run test:unit --workspace=app/frontend`
  invocation) and confirm `findConflicts()` reports no collision for the two new `BracketLeft`/
  `BracketRight` bindings added in T025.

**Checkpoint**: A user can create, list, and switch documents via the dropdown or the keyboard
shortcut. This alone is a demonstrable MVP.

---

## Phase 4: User Story 2 - Each document keeps its own independent conversations and history (Priority: P1)

**Goal**: Prove and harden that switching documents never mixes or loses content, conversations, or
revision history, and that a backgrounded document's in-flight agent response keeps running.

**Independent Test**: Start a conversation and let an agent begin streaming a response in Document
A, switch to Document B, confirm no trace of A's conversation appears, switch back and confirm the
response completed in full, and confirm each document's revision history contains only its own
entries — per spec.md US2 Acceptance Scenarios 1-3, SC-003.

### Implementation for User Story 2

- [X] T028 [US2] In `app/backend/tests/integration/`, add a test that: creates two documents, starts
  a conversation with a slow/streaming fake agent response (via `RADR_BE_PI_FAKE_SESSIONS=1`, per
  the existing fake-session harness) on Document A, subscribes to Document B's events mid-stream,
  and asserts zero events with Document A's `documentId` are ever delivered on Document B's
  subscription — proving T017/T018's WS scoping and T010's per-document `ConversationService`
  isolation hold under concurrency.
- [X] T029 [US2] In the same or a sibling integration test, assert that after switching the WS
  subscription away from Document A mid-stream (per T020's re-subscribe) and back again, the
  reconnecting client receives Document A's full, completed response via the existing
  `sinceSequence` catch-up mechanism (`EventHub.subscribe`, `app/backend/src/events/
  event-hub.ts:96-108`) with nothing missing — proving FR-006 holds at the transport layer, not just
  in the backend's continued processing.
- [X] T030 [P] [US2] In `app/backend/tests/integration/`, add a test that creates two documents,
  makes distinct manual edits and agent-applied edits to each, and asserts `GET /api/documents/
  :documentId/revisions` for each document returns only that document's revisions (via T014's
  `documentId`-scoped `storage.listRevisions` call) — proving SC-003's "100% isolation" for
  revision history specifically.
- [X] T031 [US2] In `app/frontend/src/App.vue` / `HudPanel.vue` / `HistoryPanel.vue`, verify (and fix
  if needed) that each panel's data-loading is keyed off `store.document.activeDocumentId` (T019)
  and re-fetches on change, rather than any component caching a conversation/history list across a
  document switch — this is what makes T024's switch actually show only the new document's data in
  the UI, not just correct data at the API layer.

**Checkpoint**: Both US1 and US2 verified together — documents can be created, switched, and are
provably isolated, with backgrounded agent work surviving a switch away and back.

---

## Phase 5: User Story 3 - Rename or remove a document (Priority: P2)

**Goal**: The user can give a document a meaningful title and delete documents they no longer need,
with the last remaining document protected from deletion.

**Independent Test**: Rename the active document and confirm the new title appears in the header
and dropdown immediately; delete a non-active document and confirm it disappears from the dropdown;
reduce to one document and confirm deleting it is blocked — per spec.md US3 Acceptance Scenarios
1-4.

### Implementation for User Story 3

- [X] T032 [US3] Wire `DocumentSwitcherDropdown`'s rename affordance (built in T021) to
  `store.rename(documentId, title)` (T019 → `PATCH /api/documents/:documentId` from T013),
  confirming the header title (bound to `store.document?.title`, `App.vue` ~line 713) and the
  dropdown's own row both update immediately — satisfying FR-007 and US3 Acceptance Scenario 1.
- [X] T033 [US3] Wire `DocumentSwitcherDropdown`'s delete affordance to a confirmation dialog (reuse
  the app's existing confirm-dialog pattern, e.g. `KeyboardShortcutsDialog.vue`'s dialog primitive
  if one is shared, otherwise the pattern used by the existing "close conversation" confirmation)
  before calling `store.remove(documentId)` (T019 → `DELETE /api/documents/:documentId` from T013) —
  satisfying FR-008 and US3 Acceptance Scenario 2, 4.
- [X] T034 [US3] In `DocumentSwitcherDropdown.vue`, disable/hide the delete affordance for the
  active document when `store.documents.length === 1`, and surface the backend's `409 LAST_DOCUMENT`
  error (from T013/T008) as a user-visible message if the disabled state is ever bypassed (e.g. a
  stale dropdown) — satisfying FR-009 and US3 Acceptance Scenario 3.
- [X] T035 [P] [US3] In `app/backend/tests/contract/`, add a test asserting `DELETE /api/documents/
  :documentId` on the sole remaining document returns `409` with `error.code === 'LAST_DOCUMENT'`,
  and that it returns `200` + removes the row when at least one other document exists — proving
  T008/T013's guard.

**Checkpoint**: All three user stories complete — documents can be created, switched (US1),
provably isolated (US2), and renamed/deleted with the last-document guard enforced (US3).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T036 Review every comment added/changed across this feature's diff for Constitution Principle
  VIII compliance ("Comments Are Durable, Not Historical") — no comment should narrate this change,
  reference this task list, or explain "why we removed the singleton guard" as history; only durable
  gotchas (if any) may be documented.
- [X] T037 Confirm `user_settings` (`app/backend/src/storage/sqlite/migrations.ts` ~lines 136-148)
  was left untouched by this feature, per research.md R5 — no accidental `document_id` scoping was
  introduced there.
- [X] T038 Run through all 4 scenarios in `specs/010-multi-document-support/quickstart.md` manually,
  end-to-end (dev backend + frontend), and confirm each's expected outcome, including the restart
  scenario (Scenario 4 / FR-011).
- [X] T039 Run `./scripts/verify.sh` and fix any failures until it exits green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (there is no way to have a
  second document, or to route/subscribe by document id, until T002-T020 land).
- **US1 (Phase 3)**: Depends on Foundational. No dependency on US2/US3 — independently deliverable
  as the MVP (create + switch, including the keyboard shortcut).
- **US2 (Phase 4)**: Depends on Foundational; builds on US1 existing (needs two real documents to
  switch between to exercise isolation), but its own tasks (T028-T031) are verification/hardening
  that could in principle run alongside US1's later tasks once T019/T020 land.
- **US3 (Phase 5)**: Depends on Foundational and on T021's dropdown shell (US1) existing to attach
  rename/delete affordances to; does not depend on US2.
- **Polish (Phase 6)**: Depends on all desired stories being complete.

### Parallel Opportunities

- T005 can run in parallel with T006-T011 (different files).
- T009, T010, T011 can run in parallel (different service files, same mechanical pattern).
- T014, T015, T016 can run in parallel (different route files) once T012-T013 establish the shared
  DTOs/error code and the primary document routes exist as a pattern to follow.
- T030 can run in parallel with T028-T029 (independent test files/concerns).
- T035 can run in parallel with T032-T034 (test file vs. component file).

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational) — this is the bulk of the backend risk and
   is entirely non-optional groundwork.
2. Complete Phase 3 (US1) — creating and switching documents via dropdown and hotkey.
3. **STOP and VALIDATE**: run quickstart.md Scenario 1.

### Incremental Delivery

1. Setup + Foundational → the app can hold more than one document at all.
2. US1 → validate via quickstart Scenario 1 → MVP (create/switch/hotkey).
3. US2 → validate via quickstart Scenario 2 → isolation and background-streaming guarantees proven.
4. US3 → validate via quickstart Scenario 3 → rename/delete complete the management surface.
5. Polish → constitution review, full quickstart pass (incl. Scenario 4 restart check), green
   `verify.sh`.
