# Tasks: Linear Thread Mode

**Input**: Design documents from `/specs/011-linear-thread-mode/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/thread-mode.md, quickstart.md (all present)

**Scope**: User Stories 1-3 only (FR-001–FR-012, FR-014, FR-015), per plan.md's Scope note. User Story 4 / FR-013 (Pi-native export viewer) is out of scope until the constitution amendment removing the "Pi export viewing" non-goal lands — no tasks are generated for it.

**Tests**: Not explicitly requested as TDD in the spec. Following this repo's established convention (specs 005/010's tasks.md), test/integration coverage is included as required implementation work within each phase, not as a separate optional section.

**Organization**: Tasks are grouped by user story (spec.md: US1 is P1, US2 is P2, US3 is P3) on top of a shared Foundational phase that adds the schema/contract surface every story needs.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1, US2, or US3, per spec.md
- File paths are exact, repo-root-relative

---

## Phase 1: Setup

**Purpose**: Confirm the working environment; no new package dependencies are needed — every change below modifies existing modules in `app/backend`, `app/shared`, and `app/frontend`.

- [X] T001 Confirm `git status` is clean and you're on (or have created) branch `011-linear-thread-mode`; confirm `npm run dev` (backend) and `npm run dev:frontend` start cleanly against existing canvas-mode documents — no code changes in this task.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the schema, storage-adapter, and shared-contract surface every user story needs (document type; the two new `conversation.kind` values; `piLeafEntryId`/`doneAt`/`seedExcerptText`; the shared-per-document Pi session send path). **No user story can be implemented or tested until this phase is complete.**

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Storage layer

- [X] T002 In `app/backend/src/storage/sqlite/migrations.ts`: the `conversation` table's `kind` column has an inline `CHECK (kind IN ('main', 'branch', 'review'))` (line 61) baked into the `CREATE TABLE IF NOT EXISTS` body (`STATEMENTS`, lines 55-84) — unlike a plain column default, SQLite cannot widen an existing table's `CHECK` constraint via `ALTER TABLE ADD COLUMN`, so a new `MIGRATIONS` entry (`version: 4`, appended after the existing `version: 3` entry at line 198-204) must rebuild the `conversation` table: `CREATE TABLE conversation_new` with the widened `CHECK (kind IN ('main', 'branch', 'review', 'thread-root', 'thread-branch'))` plus three new columns (`pi_leaf_entry_id TEXT`, `done_at TEXT`, `seed_excerpt_text TEXT`) added to the column list; `INSERT INTO conversation_new SELECT *, NULL, NULL, NULL FROM conversation`; `DROP TABLE conversation`; `ALTER TABLE conversation_new RENAME TO conversation`; then recreate `conversation_one_primary` and `conversation_one_current_main` (the two partial indexes on `conversation`, lines 85-88) since `DROP TABLE` drops them too. Wrap the whole `apply` function body in `db.exec('PRAGMA foreign_keys = OFF;')` / `db.exec('PRAGMA foreign_keys = ON;')` around the rebuild (referencing tables — `staged_edit`, `conversation_event`, `revision`, and `conversation.parent_id` itself — keep their FK clauses valid by table name across the rename, but must not be checked mid-rebuild).
- [X] T003 In the same file, update the fresh-install `CREATE TABLE IF NOT EXISTS conversation` body (lines 55-84) to match T002's rebuilt shape directly (widened `kind` CHECK; `pi_leaf_entry_id TEXT`, `done_at TEXT`, `seed_excerpt_text TEXT` columns) — per the file's own header comment (lines 152-168), `STATEMENTS` must independently reflect the current schema for a brand-new install, never relying on the versioned migration path.
- [X] T004 In `app/backend/src/storage/sqlite/migrations.ts`, add `addColumnIfMissing(db, 'document', 'document_type', `TEXT NOT NULL DEFAULT 'canvas'`)` to the new `version: 4` migration's `apply` (alongside T002 — `document.document_type` has no `CHECK`, so this one column is a plain `ADD COLUMN`, unlike `conversation.kind`). Also add `document_type TEXT NOT NULL DEFAULT 'canvas'` to the fresh-install `document` `CREATE TABLE IF NOT EXISTS` body (lines 7-15), per data-model.md's Document.documentType row ("Fixed at creation ...; `NOT NULL DEFAULT 'canvas'` so every pre-existing document is `'canvas'` after migration").
- [X] T005 In `app/backend/src/storage/storage-adapter.ts`: add `documentType: 'canvas' | 'thread'` to `DocumentRow` (~line 28-36); add `piLeafEntryId: string | null`, `doneAt: string | null`, `seedExcerptText: string | null` to `ConversationRow` (~lines 74-94), and extend the module's re-exported `ConversationKind` import/type to include the two new values (the type itself lives in `@rapid-ai-document-review/shared/domain`, updated by T009 below). Add `getThreadRoot(documentId: string): ConversationRow | null` to the `StorageAdapter` interface (mirrors `getMainConversation`, ~line 184, filtered to `kind: 'thread-root'`).
- [X] T006 In `app/backend/src/storage/sqlite/index.ts`: update `mapDocument()`/`mapConversation()` (the row-mapping helpers) to read/write the new columns (`document_type` → `documentType`; `pi_leaf_entry_id` → `piLeafEntryId`, `done_at` → `doneAt`, `seed_excerpt_text` → `seedExcerptText`); implement `getThreadRoot(documentId)` (`SELECT * FROM conversation WHERE document_id = ? AND kind = 'thread-root'`); update `createDocument`'s INSERT to include `document_type`, and `createConversation`'s INSERT to include the three new columns (all nullable, defaulting to `NULL`).

### Shared contracts and domain

- [X] T007 [P] In `app/shared/src/contracts/http.ts`: extend `ConversationKind` (line 12) to `z.enum(['main', 'branch', 'review', 'thread-root', 'thread-branch'])`; add `documentType: z.enum(['canvas', 'thread']).optional()` to `CreateDocumentRequest` (line 215-219, per contracts/thread-mode.md — default `'canvas'` applied server-side, not in the schema); add `doneAt: z.string().nullable()` and `seedExcerptText: z.string().nullable()` to `ConversationDto` (line 101-134); add `BranchThreadRequest = z.object({ anchorMessageId: z.string(), highlightedText: z.string().min(1), name: z.string().min(1).optional() })`, `MarkThreadDoneResponse = z.object({ threadId: z.string(), doneAt: z.string() })`, `ReopenThreadResponse = z.object({ threadId: z.string(), doneAt: z.literal(null) })`; add `'INVALID_HIGHLIGHT'`, `'ANCHOR_IS_TIP'`, `'PENDING_EDITS_BLOCK_DONE'`, `'ROOT_THREAD_UNDELETABLE'` to `ErrorCode` (line 35-55).
- [X] T008 [P] In `app/shared/src/contracts/events.ts`, add a new `ConversationDoneChangedEvent = z.object({ documentId: z.string(), conversationId: z.string(), sequence: z.number(), doneAt: z.string().nullable() })` and include it in the events discriminated union, per contracts/thread-mode.md's `conversation_done_changed`.
- [X] T009 [P] In `app/shared/src/domain/index.ts`: extend `ConversationKind` (line 26) to `'main' | 'branch' | 'review' | 'thread-root' | 'thread-branch'`; add `doneAt: string | null`, `seedExcerptText: string | null` to the `Conversation` interface (~lines 35-44); add `documentType: 'canvas' | 'thread'` to the `Document` interface.

### Pi session (shared per-document session + leaf tracking) and seed excerpt

- [X] T010 In `app/backend/src/pi/pi-service.ts`, add `async sendOnThread(thread: ConversationRow, message: string, bridge: EventBridge): Promise<void>` (placed alongside the existing `send()` method, ~line 288): resolve the thread's `SessionManager` via `SessionManager.open(thread.piSessionPath, ...)` when the file exists, else `SessionManager.create(...)` (first message ever sent in this document's threaded session — only possible for `kind: 'thread-root'`, since a `thread-branch` always seeds via T014 before its first real send); if `thread.piLeafEntryId` is non-null, call `sessionManager.branch(thread.piLeafEntryId)` before appending (repositions the shared session's leaf to this thread's own tip — a no-op if already positioned there, per research.md R1); send the message and — after it settles — persist the newly appended entry's id back onto the thread row's `piLeafEntryId` via `ThreadService` (T013). This is still the only module importing `@earendil-works/pi-coding-agent` (Constitution Principle II unchanged).
- [X] T011 [P] In `app/backend/src/conversation/seed-excerpt.ts`, add `buildThreadBranchSeedMessage(highlightedText: string): string`, following the file's existing tag-wrapping pattern (`buildSelectionOnlySeedMessage`, line 267, and `wrapDocumentRevision`'s `<document-revision-N>` convention, line 153) but wrapping in `<branch-seed-excerpt>${highlightedText}</branch-seed-excerpt>`, per research.md R4 and constitution's Quality & Review Gates seed-tagging rule.

### Thread service (new)

- [X] T012 Create `app/backend/src/conversation/thread-service.ts` with class `ThreadService`, constructor-injected with `StorageAdapter`, `PiService`, `EventPublisher` (or the same `EventService`/`EventHub` pair `ConversationService` takes) — per data-model.md's storage-layer-changes note: "deliberately a separate class from `ConversationService`... since the Pi-session strategy and the anchor resolution are both genuinely different." Stub the four public methods used by later phases: `createRoot(documentId: string): ConversationRow`, `branchFromHighlight(request): ConversationDto`, `markDone(threadId: string): { threadId: string; doneAt: string }`, `reopen(threadId: string): { threadId: string; doneAt: null }`. Wire `ThreadService` into `server.ts`'s dependency construction alongside the existing `ConversationService`.
- [X] T013 [US1] Implement `ThreadService.createRoot(documentId)` in `app/backend/src/conversation/thread-service.ts`: creates a `conversation` row with `kind: 'thread-root'`, `parentId: null`, `piSessionPath: join(document.piSessionDir, 'thread-tree.jsonl')` (one shared file per threaded-conversation document, research.md R1 — distinct from canvas's per-row `main.jsonl`/`<id>.jsonl` paths), `piLeafEntryId: null`, `doneAt: null`, `seedExcerptText: null`, `branchDepth: 0`, `contextRevision: document.currentRevision`, `isPrimary: false` (research.md R6 — never set `true` for any thread), `status: 'idle'`. Per data-model.md's validation rule: "exactly one such row exists per `documentType: 'thread'` Document" — this method is only ever called once, from `DocumentService.create()` (T017).

**Checkpoint**: Schema, contracts, and the shared Pi-session send path exist. No user-facing behavior yet — user story implementation can now begin.

---

## Phase 3: User Story 1 - Start from a single root thread and read/converse top-down (Priority: P1) 🎯 MVP

**Goal**: Creating a document as a "threaded conversation" produces exactly one auto-created root Thread, rendered top-down, with no way to create a second independent top-level Thread; the root behaves like any other thread except it can never be deleted.

**Independent Test**: Create a document choosing "threaded conversation" as its type; verify exactly one root thread exists and renders at the top of a top-down list; verify no UI action creates a second top-level thread; send a message in the root thread and confirm it appends normally.

### Backend

- [X] T014 [US1] In `app/backend/src/document/document-service.ts`, add a `documentType: 'canvas' | 'thread' = 'canvas'` parameter to `create()` (~line 209): pass it through to `this.storage.createDocument(...)` (~line 215-224); when `documentType === 'thread'`, call `threadService.createRoot(documentRow.id)` instead of building/seeding a `kind: 'main'` conversation (the existing ~lines 240-263 canvas-mode Main-creation block) — `DocumentService` needs `ThreadService` injected alongside its existing `ConversationService` dependency for this branch.
- [X] T015 [US1] In `app/backend/src/api/http/document.ts`, update `POST /api/documents` (line 22-25) to read `data.documentType` (from T007's `CreateDocumentRequest` extension) and pass it to `documentService.create(data.content, data.title, data.documentType)`.
- [X] T016 [US1] In `app/backend/src/api/http/threads.ts` (new file, mirroring `conversations.ts`'s structure): add `POST /api/documents/:documentId/threads/:id/send` delegating to the existing send-handling logic but routed through `PiService.sendOnThread` (T010) when `conversation.kind` starts with `'thread-'` — reuse `ConversationService.send()`'s validation (closed/not-found checks) by having `ConversationService.send` itself dispatch to `piService.sendOnThread` vs `piService.send` based on `conversation.kind`, rather than duplicating the whole method in `ThreadService`. Register the new route file in `server.ts`'s route registration alongside `conversations.ts`.
- [X] T017 [US1] In `app/backend/src/api/http/threads.ts`, add `GET /api/documents/:documentId/threads` returning the same shape as `GET .../conversations` (`ListConversationsResponse`), filtered server-side to `kind IN ('thread-root', 'thread-branch')` — per contracts/thread-mode.md, "for a `documentType: 'thread'` document this list is exactly that document's Threads."
- [X] T018 [US1] Add a `DocumentNotThreadTypeError` guard (or reuse an existing pattern) so `POST .../threads/...` routes 404/409 cleanly if called against a `documentType: 'canvas'` document, and the existing `POST .../conversations` routes reject `kind: 'thread-*'` documents symmetrically — enforces FR-014's "fixed at creation" at the API boundary, not just in the UI.

### Frontend

- [X] T019 [P] [US1] In the document-creation UI added by spec 010 (the "+ New document" dropdown action, `app/frontend/src/components/header/DocumentSwitcherDropdown.vue` or wherever `POST /api/documents` is called from), add a document-type choice (canvas vs. threaded conversation) presented at creation time, sent as `documentType` in the create request (T015).
- [X] T020 [P] [US1] Create `app/frontend/src/components/thread/ThreadModeView.vue`: renders a single top-down, vertically-ordered list of Threads (FR-002) for the active document, fetched via `GET /api/documents/:documentId/threads` (T017); no control anywhere in this component creates a new independent top-level thread (FR-003) — the only compose affordance is on each Thread's own tip.
- [X] T021 [US1] Create `app/frontend/src/components/thread/ThreadCard.vue` (one Thread's rendering) and `app/frontend/src/components/thread/ThreadComposer.vue` (send box), reusing the existing message-rendering/sanitized-Markdown components from canvas mode (`MessageBubble.vue`) rather than re-implementing message display.
- [X] T022 [US1] In `app/frontend/src/App.vue`, branch the top-level layout: when the active document's `documentType === 'thread'`, mount `ThreadModeView.vue` in place of the existing Preview/`DocumentCanvas`/History grid (~lines 9-11 imports); when `'canvas'`, render exactly as today. Add a small document-type indicator/badge next to each entry in the document-switcher dropdown (contracts/thread-mode.md's "Frontend routing/view contract").
- [X] T023 [P] [US1] Add a Pinia store slice (new `app/frontend/src/stores/thread.ts` or an extension of the existing conversation store) tracking the active threaded-conversation document's Threads list and each Thread's messages, mirroring the existing conversation store's shape.

### Tests

- [X] T024 [P] [US1] In `app/backend/tests/integration/`, add a test that creates a `documentType: 'thread'` document and asserts exactly one `kind: 'thread-root'` conversation row exists, with `parentId: null`, `piLeafEntryId: null`, `doneAt: null`.
- [X] T025 [P] [US1] In `app/backend/tests/contract/`, add a test asserting `POST /api/documents/:documentId/conversations` (the canvas-mode branch/create route) is refused for a `documentType: 'thread'` document (T018), and that `POST .../threads/...` routes are refused for a `documentType: 'canvas'` document.
- [X] T026 [US1] Run `quickstart.md` Scenario 1 manually (or as a new `tests/e2e/us11.spec.ts` Playwright spec) and confirm it passes.

**Checkpoint**: A threaded-conversation document can be created, has exactly one root thread, renders top-down, and that thread can send/receive messages.

---

## Phase 4: User Story 2 - Highlight a passage to branch, with the excerpt seeded into the new branch (Priority: P2)

**Goal**: Highlighting a passage in any non-tip message of a Thread and branching produces a genuine same-session Pi branch, seeded with that passage wrapped in `<branch-seed-excerpt>`; the source thread's rendering visually splits into segments at each branch point; only a Thread's tip segment accepts new messages; multiple branches from the same message render as siblings.

**Independent Test**: From a thread with ≥3 turns, highlight a passage in an earlier (non-tip) message and branch; verify the new thread shares history up to that message, is seeded with the XML-wrapped excerpt, is a genuine leaf-branch of the same Pi session file (not a separate file), and that highlighting the tip message is refused.

### Backend

- [X] T027 [US2] In `app/backend/src/conversation/thread-service.ts`, implement `branchFromHighlight({ parentThreadId, anchorMessageId, highlightedText, name })`: load the parent thread and its `SessionManager.open(parent.piSessionPath)`; resolve `anchorMessageId` to a Pi entry id via `getEntries()`/`getTree()` (research.md R2) and validate `highlightedText` is an exact substring of that entry's rendered text (else throw `InvalidHighlightError` → `400`/`INVALID_HIGHLIGHT`); reject if the resolved entry is the parent thread's current leaf (`parent.piLeafEntryId`) (`ANCHOR_IS_TIP`, FR-007); enforce `maxConversationDepth` exactly as `ConversationService.branch()` does (reuse `MaxConversationDepthExceededError`, FR-012); create a new `conversation` row: `kind: 'thread-branch'`, `parentId: parentThreadId`, `piSessionPath: parent.piSessionPath` (same shared file, research.md R1), `piLeafEntryId: <resolved anchor entry id>`, `forkedFromMessageId: anchorMessageId`, `seedExcerptText: highlightedText`, `branchDepth: parent.branchDepth + 1`, `doneAt: null`, `isPrimary: false`; deliver the seed message (T011's `buildThreadBranchSeedMessage(highlightedText)`) into the new branch's session position via `piService.seedSession`-equivalent (reuse the existing seed-then-don't-trigger-a-turn convention, `PiService.seedSession`/`ConversationService.sendBranchSeedMessage`, `isSeed: true`).
- [X] T028 [US2] In `app/backend/src/api/http/threads.ts`, add `POST /api/documents/:documentId/threads/:id/branch` accepting `BranchThreadRequest` (T007), delegating to `threadService.branchFromHighlight`, mapping `InvalidHighlightError`/anchor-is-tip/`MaxConversationDepthExceededError` to their respective `ErrorCode`s (contracts/thread-mode.md).

### Frontend

- [X] T029 [P] [US2] Create `app/frontend/src/components/thread/HighlightBranchMenu.vue`: a selection popover that appears when the reviewer selects text inside a non-tip message, offering a "Branch from here" action that calls T028 with the selected text and the message's id; suppressed entirely when the selection is inside a Thread's own tip segment (FR-007 at the UI layer, not just the API).
- [X] T030 [US2] Create `app/frontend/src/composables/useThreadSegments.ts`: given a Thread's own message list plus every other Thread's `forkedFromMessageId`/`parentId` in the same document, compute the frontend-only `ThreadSegment[]` described in data-model.md (message-index ranges, `isTipSegment`, `childBranchIds`) — pure function, no API calls, per research.md R5.
- [X] T031 [US2] In `ThreadCard.vue` (T021), use `useThreadSegments` (T030) to render each Thread as one or more stacked segment boxes, left-aligned/inline with the segment they continue; render each `childBranchIds` entry as an indented sibling fork immediately after its segment (FR-005b — visual only, no change to any stored thread). Mount `ThreadComposer.vue` (T021) only on a segment where `isTipSegment === true` (FR-005c) — every other segment shows the highlight-to-branch affordance only, no compose box.
- [X] T032 [P] [US2] In `ThreadCard.vue`, render the new branch's first message with its `seedExcerptText` (T007's `ConversationDto` field) visually distinguished (e.g. a quote-style banner) ahead of the reviewer's own appended text, reflecting the `<branch-seed-excerpt>` wrapping sent to the model.

### Tests

- [X] T033 [P] [US2] In `app/backend/tests/integration/`, add a test that: creates a threaded document, sends 3 messages in the root, branches from the 2nd message's text; asserts the new thread's `piSessionPath` equals the root's, `piLeafEntryId` equals the 2nd message's resolved entry id, and the underlying Pi session file (via `SessionManager.open(path).getTree()`) shows both threads as leaves under a shared ancestor path — not two independent single-root trees.
- [X] T034 [P] [US2] In `app/backend/tests/contract/`, add a test asserting `POST .../threads/:id/branch` with `anchorMessageId` equal to the thread's current tip returns `409`/`ANCHOR_IS_TIP`, and with `highlightedText` not present in that message returns `400`/`INVALID_HIGHLIGHT`.
- [X] T035 [P] [US2] In `app/frontend/tests/unit/`, add a test for `useThreadSegments` covering: a thread with zero branches (one segment, `isTipSegment: true`), one branch partway through (two segments, first `isTipSegment: false`), and two branches anchored at the same message (both listed in that segment's `childBranchIds`).
- [X] T036 [US2] Run `quickstart.md` Scenarios 2-3 manually (or as `tests/e2e/us11.spec.ts` additions) and confirm they pass.

**Checkpoint**: Highlight-to-branch works end-to-end as a genuine same-session Pi branch, with correct XML-tagged seeding and correct segment-splitting rendering, including multi-sibling branch points and frozen non-tip segments.

---

## Phase 5: User Story 3 - Mark a thread done to declutter the view (Priority: P3)

**Goal**: A reviewer can mark a Thread done (hidden from the default list, non-destructive, reversible) and reopen it later; a done thread remains fully branchable; marking done is blocked while staged edits are unresolved; marking a parent done never hides its still-active branches.

**Independent Test**: Mark an active thread done; verify it disappears from the default list immediately but is retrievable with full history via a done/history view; verify branching from it still works; verify marking done is refused while it has a pending staged edit.

### Backend

- [X] T037 [US3] In `app/backend/src/conversation/thread-service.ts`, implement `markDone(threadId)`: throw the same `PendingEditsBlockCloseError`-shaped guard `ConversationService.close()` uses (extract the pending-staged-edits check, currently inline in `close()` lines 470-478, into a shared helper — e.g. a function in `edit-mapper.ts` or a new small module — reused by both `close()` and `markDone()`, per research.md R3) mapped to `409`/`PENDING_EDITS_BLOCK_DONE`; otherwise set `doneAt: new Date().toISOString()` and publish `conversation_done_changed` (T008).
- [X] T038 [US3] In `app/backend/src/conversation/thread-service.ts`, implement `reopen(threadId)`: sets `doneAt: null` (no-op/200 if already `null`, per contracts/thread-mode.md's idempotency note) and publishes `conversation_done_changed`.
- [X] T039 [US3] In `app/backend/src/api/http/threads.ts`, add `POST /api/documents/:documentId/threads/:id/done` and `POST /api/documents/:documentId/threads/:id/reopen`, delegating to T037/T038 and mapping their responses to `MarkThreadDoneResponse`/`ReopenThreadResponse` (T007).
- [X] T040 [US3] In `app/backend/src/events/event-publisher.ts` (or wherever the closed event-type vocabulary is enumerated), add `conversation_done_changed` to the emitted-event set, publishing `{ documentId, conversationId, doneAt }` via the existing `publish(documentId, conversationId, type, data)` helper (line 27).

### Frontend

- [X] T041 [P] [US3] In `ThreadModeView.vue` (T020), filter the default top-down list to `doneAt === null` Threads only (FR-008).
- [X] T042 [US3] Create `app/frontend/src/components/thread/DoneThreadsPanel.vue`: a separate view/panel listing `doneAt !== null` Threads for the active document with their full history intact and a "Reopen" action (calls T039's reopen route).
- [X] T043 [P] [US3] In `ThreadCard.vue`/`ThreadModeView.vue`, subscribe to `conversation_done_changed` (T008/T040) over the existing WebSocket connection so the default list and done panel update live without a full re-fetch (SC-003/SC-004).
- [X] T044 [P] [US3] Add a "Mark done" action to each active Thread's UI (T021), disabled/erroring via the `PENDING_EDITS_BLOCK_DONE` response (T037) when the thread has unresolved staged edits, surfaced the same way other blocked actions already are in this codebase.

### Tests

- [X] T045 [P] [US3] In `app/backend/tests/integration/`, add a test that marks a thread done, asserts it is excluded from `GET .../threads` when an "active only" filter/default is applied but still retrievable via a done-inclusive fetch, then reopens it and asserts it reappears in the default list.
- [X] T046 [P] [US3] In `app/backend/tests/contract/`, add a test asserting `POST .../threads/:id/done` returns `409`/`PENDING_EDITS_BLOCK_DONE` when the thread has a `status: 'pending'` staged edit, and that branching from a done thread (T028) still succeeds (Edge Cases).
- [X] T047 [P] [US3] In `app/backend/tests/integration/`, add a test that marks a `thread-root` done while one of its branches is still active, and asserts the branch remains present in the default `GET .../threads` list (FR-011).
- [X] T048 [US3] Run `quickstart.md` Scenario 4 manually (or as `tests/e2e/us11.spec.ts` additions) and confirm it passes.

**Checkpoint**: All three in-scope user stories are independently functional; done/reopen is non-destructive and correctly scoped.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories.

- [X] T049 [P] Update `app/frontend/src/a11y/keymap-registry.ts` with any new bound shortcut actually introduced during implementation (e.g. jump-to-next-thread), per the constitution's "single source of truth" rule — skip if none was added.
- [X] T050 Review every comment added or changed in this feature's diff for constitution Principle VIII compliance (durable, non-historical, no task/ticket references).
- [X] T051 [P] Update root-level docs (README or equivalent) to mention the new "threaded conversation" document type, if the project's existing doc set covers document-creation options.
- [X] T052 Run `quickstart.md` end-to-end (all four scenarios) against a fresh, unmigrated SQLite database to confirm T002-T004's migration path works on both a brand-new install and one upgraded from a pre-`documentType` schema.
- [X] T053 Run `./scripts/verify.sh` (or the project's standard lint/typecheck/test aggregate) and fix any failures until it exits green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories (schema/contracts/shared Pi-session path every story needs).
- **User Stories (Phase 3-5)**: All depend on Foundational completion.
  - US1 has no dependency on US2/US3.
  - US2 depends on US1's `ThreadModeView`/`ThreadCard` scaffolding (T020-T021) existing to attach the highlight-branch UI to, and on US1's `sendOnThread` path (T010) for delivering seed messages — cannot be meaningfully tested standalone without a root thread to branch from.
  - US3 depends only on Foundational's `doneAt` column/`conversation_done_changed` event (Phase 2) and US1's `ThreadModeView` list to filter — does not require US2's branching to be implemented first (a document with only a root thread can still be marked done).
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### Within Each User Story

- Backend service/route tasks before frontend tasks that call them.
- `ThreadService` methods before the HTTP routes that call them.
- Tests follow (or, if written first per team preference, must fail before) their corresponding implementation tasks.

### Parallel Opportunities

- T007, T008, T009 (shared contracts/domain, three different files) can run in parallel.
- T011 (seed-excerpt) can run in parallel with T010 (pi-service) — different files, no dependency between them.
- Within US1: T019 and T020/T023 (different frontend files) can run in parallel once T015/T017 exist.
- Within US2: T029, T030, T033, T034, T035 can run in parallel (different files).
- Within US3: T041, T043, T044, T045, T046, T047 can run in parallel (different files).

---

## Parallel Example: Foundational Phase

```bash
# Launch the three independent shared-contract updates together:
Task: "Extend ConversationKind/CreateDocumentRequest/ConversationDto/BranchThreadRequest in app/shared/src/contracts/http.ts"
Task: "Add ConversationDoneChangedEvent in app/shared/src/contracts/events.ts"
Task: "Extend ConversationKind and add doneAt/seedExcerptText/documentType in app/shared/src/domain/index.ts"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (schema, contracts, shared Pi-session send path).
3. Complete Phase 3: User Story 1 — a threaded-conversation document with one root thread that can send/receive messages.
4. **STOP and VALIDATE**: run quickstart.md Scenario 1.
5. Deploy/demo if ready.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add User Story 1 → validate → demo (MVP).
3. Add User Story 2 → validate → demo (highlight-to-branch, segments).
4. Add User Story 3 → validate → demo (done/declutter).
5. Each story adds value without breaking the previous ones — US2/US3 never modify US1's core send/list paths, only add to them.
