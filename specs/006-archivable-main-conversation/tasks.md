---

description: "Task list template for feature implementation"
---

# Tasks: Archivable Main Conversation

**Input**: Design documents from `/specs/006-archivable-main-conversation/`

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required for user stories), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/main-archive.md](./contracts/main-archive.md), [quickstart.md](./quickstart.md)

**Tests**: Included, following this repo's existing convention (backend Vitest unit/integration/contract suites; frontend Vitest component/unit suites; repo-root Playwright e2e) and the constitution's Quality & Review Gate requiring Given/When/Then acceptance criteria before a user-facing change is considered complete.

**Organization**: Tasks are grouped by user story (spec.md P1–P3) to enable independent implementation and testing of each story.

**Execution**: When implementing this task list, run each phase (Setup, Foundational, each User Story, Polish) in its own subagent, in dependency order per the Dependencies section below. A phase's subagent must complete (and its tasks marked `[X]`) before the next dependent phase's subagent starts; phases with no dependency between them may run in parallel subagents.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US3)
- Exact file paths are included in every task description

## Path Conventions

Web app (existing layout): `app/shared/src`, `app/backend/src`, `app/backend/tests`,
`app/frontend/src`, `app/frontend/tests`, `tests/e2e` (repo-root Playwright suite).

---

## Phase 1: Setup

No new project, package, dependency, or tooling initialization is required — this feature adds one
column/index to an existing table and edits existing backend/frontend modules. Skipping directly to
Foundational.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The persisted `isCurrentMain` flag, its schema/migration, and the new busy-guard error
— every user story's implementation and tests depend on these existing first.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T001 [P] Add `isCurrentMain: boolean` to the `Conversation` interface in `app/shared/src/domain/index.ts` (data-model.md §Conversation).
- [X] T002 [P] Add `isCurrentMain: z.boolean()` to `ConversationDto` in `app/shared/src/contracts/http.ts`; add `'CONVERSATION_BUSY'` to the `ErrorCode` enum and remove `'CANNOT_CLOSE_MAIN_CONVERSATION'` (data-model.md §ConversationDto, §Errors; contracts/main-archive.md).
- [X] T003 Add `is_current_main INTEGER NOT NULL DEFAULT 0` to the `conversation` table's `CREATE TABLE IF NOT EXISTS` body and a `CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_current_main ON conversation (document_id) WHERE is_current_main = 1` statement to `STATEMENTS` in `app/backend/src/storage/sqlite/migrations.ts` (data-model.md §Migration). Depends on T001/T002 only for consistency of naming, not a code dependency.
- [X] T004 Add a new versioned migration (`version: 2`) to the `MIGRATIONS` array in `app/backend/src/storage/sqlite/migrations.ts` that (a) `addColumnIfMissing(db, 'conversation', 'is_current_main', 'INTEGER NOT NULL DEFAULT 0')`, (b) backfills `UPDATE conversation SET is_current_main = 1 WHERE kind = 'main' AND status != 'closed'`, then (c) `db.exec('CREATE UNIQUE INDEX IF NOT EXISTS conversation_one_current_main ON conversation (document_id) WHERE is_current_main = 1')` (data-model.md §Migration). Depends on T003.
- [X] T005 [P] Add `isCurrentMain: boolean` to `ConversationRow` in `app/backend/src/storage/storage-adapter.ts` (data-model.md §Conversation). Depends on T001.
- [X] T006 Update `createConversation`, `updateConversation`, and `getMainConversation` in `app/backend/src/storage/sqlite/index.ts`: include `is_current_main`/`isCurrentMain` in the INSERT/UPDATE column lists and bound params, and change `getMainConversation`'s query from `WHERE document_id = ? AND kind = 'main'` to `WHERE document_id = ? AND kind = 'main' AND is_current_main = 1` (research.md §2; data-model.md §Migration). Depends on T004, T005.
- [X] T007 Update `mapConversation` (wherever `ConversationDbRow` → `ConversationRow` mapping lives in `app/backend/src/storage/sqlite/index.ts`) to read `is_current_main` into `isCurrentMain`. Depends on T006.
- [X] T008 [P] Add `isCurrentMain: row.isCurrentMain` to `buildConversationDto` in `app/backend/src/conversation/conversation-mapper.ts` (data-model.md §ConversationDto). Depends on T007.
- [X] T009 Set `isCurrentMain: true` on every existing `createConversation({ kind: 'main', ... })` call site — `ConversationService.ensureMain` (`app/backend/src/conversation/conversation-service.ts`) and `DocumentService.create`'s direct Main insert (`app/backend/src/document/document-service.ts`) — so a freshly created document's Main is correctly flagged current from the start. Depends on T006.
- [X] T010 [P] Add a new `ConversationBusyError extends Error` class next to the other error classes in `app/backend/src/conversation/conversation-service.ts` (data-model.md §Errors), following the existing class-definition style (e.g. `PendingEditsBlockCloseError`).
- [X] T011 Map `ConversationBusyError` to `409`/`CONVERSATION_BUSY` in `handleConversationError` in `app/backend/src/api/http/conversations.ts`; remove the `CannotCloseMainConversationError` branch and its import (contracts/main-archive.md). Depends on T010, T002.
- [X] T012 [P] Unit tests for the new migration in `app/backend/tests/unit/migrations.test.ts`: a fresh DB gets the column + unique index; an existing DB missing the column gets it added, its single non-closed `kind='main'` row backfilled to `is_current_main = 1`, and the unique index created. Depends on T004.

**Checkpoint**: `isCurrentMain` is persisted, migrated, and surfaced end-to-end (DB → DTO); `CONVERSATION_BUSY` exists and is wired to the HTTP error table. User story implementation can now begin.

---

## Phase 3: User Story 1 - Retire an overgrown Main and start a fresh round (Priority: P1) 🎯 MVP

**Goal**: Archiving the current Main atomically closes it (full history/context preserved,
read-only) and replaces it with a new, empty, freshly-seeded Main in the same slot — never leaving
the document without a usable Main.

**Independent Test**: Open a document with an active Main containing messages, archive it, and
verify a new empty Main is immediately available in the same slot while the archived Main's full
history remains viewable elsewhere (quickstart.md Scenario 1).

### Tests for User Story 1

- [X] T013 [P] [US1] Unit test for the `status === 'working'` guard in `close()` in `app/backend/tests/unit/conversation-service.test.ts` (or the existing close-related unit test file): throws `ConversationBusyError` for a `working` conversation of any `kind`, for both Main and non-Main.
- [X] T014 [P] [US1] Integration test in `app/backend/tests/integration/main-archive.test.ts` (new): archiving Main against a real SQLite file atomically produces exactly one `is_current_main = 1` row for the document at every point (before, during a simulated failure injected mid-transaction, and after), the old Main ends up `status: 'closed'`/`isCurrentMain: false`, and the new Main is seeded with the document's current content.
- [X] T015 [P] [US1] Contract test in `app/backend/tests/contract/http.test.ts`: replace the existing `409 CANNOT_CLOSE_MAIN_CONVERSATION` case (currently at line ~865) with a case asserting `POST /api/conversations/:id/close` on a Main conversation succeeds (`200`, `status: 'closed'`), and that a subsequent `GET` for the document shows a new `kind: 'main', isCurrentMain: true` conversation distinct from the now-`isCurrentMain: false` archived one. Also add cases for: `409 PENDING_EDITS_BLOCK_CLOSE` when Main has a pending proposal, `409 CONVERSATION_BUSY` when Main `status === 'working'`, and a retried close on an already-archived Main returning the same idempotent `200` with no second replacement created.
- [X] T016 [P] [US1] Contract test in `app/backend/tests/contract/http.test.ts`: archiving a Primary Main clears Primary with no transfer (`GET` afterward shows no conversation with `isPrimary: true`) — FR-007.
- [X] T017 [P] [US1] Component test in `app/frontend/tests/component/ConversationView.spec.ts`: `archiveOrReviewAction` now returns the "Archive" action for an open `kind: 'main'` conversation (previously `null`), unchanged for every other kind/status.

### Implementation for User Story 1

- [X] T018 [US1] In `ConversationService.close()` (`app/backend/src/conversation/conversation-service.ts`), remove the `conversation.kind === 'main'` early-throw block (and the now-unused `CannotCloseMainConversationError` class/import). Depends on T011.
- [X] T019 [US1] Add the `status === 'working'` guard to `close()`: throw `ConversationBusyError` before the pending-edits check, for every `kind`. Depends on T018, T010.
- [X] T020 [US1] Add a `archiveMain(documentId: string)` method to `ConversationService` (`app/backend/src/conversation/conversation-service.ts`) implementing the archive-and-replace transaction (research.md §5): inside `this.storage.transaction(() => { ... })`, update the current Main to `status: 'closed', closedAt, isCurrentMain: false`, then `createConversation` a new Main row (`kind: 'main', isCurrentMain: true, isPrimary: false, parentId: null, status: 'idle', branchDepth: 0, seedSelection: null, forkedFromMessageId: null`, fresh `piSessionPath`, `contextRevision: document.currentRevision`). Depends on T009.
- [X] T021 [US1] After the transaction in `archiveMain` (mirroring `close()`'s existing post-write ordering): if the old Main was Primary, call `this.primaryService.closeClears(oldMainId)`; publish `conversation_closed` for the old Main and `conversation_started` for the new one (reusing the existing `publish` helper and event shapes); evict the old Main's Pi session (reusing the existing eviction call from `close()`); call `this.seedMain(newMainId, document.title, document.currentRevision, content)`. Depends on T020.
- [X] T022 [US1] Wire `close()`'s `kind === 'main'` branch to call `archiveMain(conversation.documentId)` instead of the removed throw, placed after the already-closed idempotent early-return (line ~416) and after the new busy/pending-edit guards, so a retried close on an archived Main is a no-op (research.md §5 idempotency note). Depends on T019, T020, T021.
- [X] T023 [US1] In `app/frontend/src/components/conversation/ConversationView.vue`, drop the `conversation.value.kind !== 'main'` condition from `archiveOrReviewAction` so Main gets the same "Archive" action/confirmation-dialog flow as any other kind. Depends on T022.

**Checkpoint**: User Story 1 is fully functional and independently testable — archiving Main atomically replaces it with a fresh, seeded Main; archived Main is fully read-only per existing closed-conversation guarantees.

---

## Phase 4: User Story 2 - Branches survive their parent Main's archival (Priority: P2)

**Goal**: A conversation branched from Main keeps working normally, and keeps showing its
historical link to that Main, after the Main is archived.

**Independent Test**: Branch off Main, archive Main, then verify the branch is still open, usable,
branchable further, and still shows its link to the now-archived parent (quickstart.md Scenario 2).

**Note**: No implementation change is expected for this story — `Conversation.parentId` is never
rewritten by a close, and `useConversationContinuity`'s parent lookup is a live read of the (never
deleted) parent row (research.md §3, data-model.md §Branch → archived-Main linkage). This phase
exists to prove that by test.

### Tests for User Story 2

- [X] T024 [P] [US2] Integration test in `app/backend/tests/integration/main-archive.test.ts`: branch a conversation from Main, archive that Main, then assert the branch's `status` is unchanged, it accepts a new message, and it can still be branched from (subject to `maxConversationDepth`).
- [X] T025 [P] [US2] E2E test in `tests/e2e/us9.spec.ts` (new): branch from Main, archive Main, confirm the branch box/detail view still renders its "Branched from {name}" link and the parent conversation's name/badge reflects it is now archived (quickstart.md Scenario 2).

**Checkpoint**: User Stories 1 and 2 both verified working — archiving Main is non-destructive to existing branches.

---

## Phase 5: User Story 3 - Review what happened in a past round via the archived Main (Priority: P3)

**Goal**: Edits an archived Main auto-applied while current remain attributed to it in revision
history, and archived Mains are visually distinguishable from each other and from the current Main.

**Independent Test**: Archive a Main that auto-applied at least one edit, then confirm that edit's
attribution to that specific archived Main is still visible in revision history, and that multiple
archived Mains plus the current Main are each individually identifiable (quickstart.md Scenario 3).

### Tests for User Story 3

- [X] T026 [P] [US3] Integration test in `app/backend/tests/integration/main-archive.test.ts`: while Main is Primary, an auto-applied edit's revision records `conversationId` = that Main's id; after archiving, `GET /api/revisions` still shows that revision attributed (by id and resolved `conversationName`) to the now-archived Main (FR-011).
- [X] T027 [P] [US3] Component test in `app/frontend/tests/component/conversationStatusBadges.spec.ts`: `useConversationStatusBadges` renders an "Archived Main" badge (or equivalent distinguishing label) when `kind === 'main' && status === 'closed'`, and does not render it for the current Main (`isCurrentMain: true`) or for a closed non-Main conversation.
- [X] T028 [P] [US3] E2E test in `tests/e2e/us9.spec.ts`: archive Main twice in succession (producing two archived Mains plus one current Main), confirm the conversation list shows all three as individually distinguishable, and confirm the History panel still attributes each archived Main's auto-applied edit to the correct specific conversation (quickstart.md Scenario 3).

### Implementation for User Story 3

- [X] T029 [US3] Add an "Archived Main" (or equivalent) badge case to `useConversationStatusBadges` in `app/frontend/src/composables/conversationStatusBadges.ts`, keyed off `kind === 'main' && status === 'closed'`, rendered via the existing shared `ConversationStatusBadges.vue` so `HudPanel.vue`/`ConversationThreadBox.vue`/`ConversationView.vue` all pick it up with no per-component change (research.md §6). Depends on T008 (isCurrentMain available) though the badge itself keys off `status`, not `isCurrentMain`.

**Checkpoint**: All three user stories independently functional — archiving, branch survival, and historical attribution/distinguishability all verified.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements spanning multiple user stories.

- [X] T030 Run quickstart.md Scenarios 1–3 end-to-end against a running dev instance, confirming no intermediate no-Main state is ever observable and every edge case (pending-proposal block, busy block, zero-message Main archivable) behaves as specified.
- [X] T031 [P] Flagged (not amended, per scope): `.specify/memory/constitution.md`'s UI Conventions
  section (line ~151-154) still reads: '"Close" while the conversation is still open and its kind
  is not `main`' — this carve-out is now stale, since Main can be archived (closed) like any other
  conversation kind as of this feature. A follow-up MUST run `/speckit-constitution` (the
  constitution workflow) to amend this sentence to drop the `kind is not main` exception, bumping
  the version per the existing PATCH/MINOR policy (this is a wording correction with no new
  principle, so PATCH). Not done as part of this task list, per its own instruction to flag rather
  than amend directly from a feature branch.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: None — skipped.
- **Foundational (Phase 2)**: No dependencies beyond Setup. BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational only.
- **User Story 2 (Phase 4)**: Depends on Foundational and on User Story 1 being implemented (there is nothing to archive-and-verify-survival-of until archiving exists) — implement after US1. Introduces no new production code itself.
- **User Story 3 (Phase 5)**: Depends on Foundational and on User Story 1 (archiving must exist to produce an archived Main to attribute/badge). Independent of US2.
- **Polish (Phase 6)**: Depends on all three user stories.

### Within Each User Story

- Tests are written before implementation and should fail first.
- Backend service-layer changes (`archiveMain`, guards) before the frontend action-gating change that calls them.
- Story complete and checkpointed before moving to the next priority.

### Parallel Opportunities

- T001/T002 (shared type/contract changes) in parallel; T005 in parallel with T001/T002.
- T010 (new error class) in parallel with T001-T009 (disjoint files) until T011 needs both.
- T012 in parallel with US1 test tasks once T004 lands.
- Within US1, T013–T017 (all test files) can run in parallel with each other, but not with T018–T023.
- Within US3, T026/T027/T028 (disjoint test files) in parallel.
- T024/T025 (US2) in parallel with each other; T026/T027/T028 (US3) in parallel with T024/T025 since the stories touch disjoint files, once US1 implementation has landed.

---

## Parallel Example: Foundational Phase

```bash
Task: "Add isCurrentMain: boolean to Conversation in app/shared/src/domain/index.ts"
Task: "Add isCurrentMain to ConversationDto and CONVERSATION_BUSY/-CANNOT_CLOSE_MAIN_CONVERSATION to ErrorCode in app/shared/src/contracts/http.ts"
Task: "Add isCurrentMain: boolean to ConversationRow in app/backend/src/storage/storage-adapter.ts"
Task: "Add ConversationBusyError class in app/backend/src/conversation/conversation-service.ts"
```

## Parallel Example: User Story 1

```bash
Task: "Unit test for the working-status close guard in app/backend/tests/unit/conversation-service.test.ts"
Task: "Integration test for atomic archive-and-replace in app/backend/tests/integration/main-archive.test.ts"
Task: "Contract test replacing CANNOT_CLOSE_MAIN_CONVERSATION in app/backend/tests/contract/http.test.ts"
Task: "Component test for Archive action visibility in app/frontend/tests/component/ConversationView.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (blocks everything).
2. Complete Phase 3: User Story 1 — archive-and-replace.
3. **STOP and VALIDATE**: run quickstart.md Scenario 1 independently.
4. Demo: archive a long-running Main, get a fresh seeded Main in the same slot.

### Incremental Delivery

1. Foundational → schema/error plumbing ready.
2. Add User Story 1 → validate → demo (MVP: archive-and-replace).
3. Add User Story 2 → validate → demo (branches unaffected).
4. Add User Story 3 → validate → demo (attribution + distinguishability).
5. Polish.

## Notes

- No new runtime dependency is introduced anywhere in this task list.
- `CannotCloseMainConversationError`/`CANNOT_CLOSE_MAIN_CONVERSATION` are removed, not deprecated —
  they exist today solely as this feature's placeholder guard (research.md §1).
- Commit after each task or logical group; verify tests fail before implementing; stop at any
  checkpoint to validate a story independently.
