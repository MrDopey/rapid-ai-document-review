---

description: "Task list template for feature implementation"
---

# Tasks: History Revision Diff View

**Input**: Design documents from `/specs/004-history-diff-view/`

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required for user stories), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md)

**Tests**: Included, following this repo's existing convention (backend has extensive Vitest contract/unit/integration suites; the frontend has declared but unused `test:unit`/`test:component` Vitest scripts, and a repo-root Playwright e2e suite). This feature adds the first frontend Vitest component tests.

**Documentation**: No root `README.md` or `docs/` update is included — the existing README documents this project at an architectural level (e.g. "diff review" as a capability) and does not enumerate individual History-tab actions (Restore/Download/Copy aren't documented either), so a "Diff" action needs no separate doc task.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

**Execution**: When implementing this task list, run each phase (Setup, Foundational, each User Story, Polish) in its own subagent, in dependency order per the Dependencies section below. A phase's subagent must complete (and its tasks marked `[X]`) before the next dependent phase's subagent starts; phases with no dependency between them may run in parallel subagents.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions

Web app (existing layout): `app/backend/src`, `app/backend/tests`, `app/frontend/src`,
`app/frontend/tests` (new), `tests/e2e` (repo-root Playwright suite). No backend or `app/shared`
changes are needed for this feature (see [plan.md](./plan.md) Project Structure).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Enable frontend Vitest component tests, which do not yet run in this repo.

- [X] T001 Add a `test: { environment: 'jsdom' }` block to `app/frontend/vite.config.ts` (Vitest reads Vite's config) so `npm run test:component` (already declared in `app/frontend/package.json` as `vitest run tests/component`) can mount Vue components; confirm `jsdom` (already a devDependency) and `@vue/test-utils` are sufficient with no further config.

**Checkpoint**: `npm run test:component` runs (even with zero test files) without erroring on missing DOM globals.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared component shell that both user stories' behavior is built on or verified against.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T002 [P] Create `app/frontend/src/components/diff/RevisionDiffViewer.vue` skeleton: props `revision: number`, `previousRevision: number`; emits `close`; a `role="dialog"` modal shell with a header (title + Close button) and focus trap wired via `useFocusTrap` from `app/frontend/src/a11y/focus-manager.js`, mirroring the structure of the existing `app/frontend/src/components/diff/DiffViewer.vue`. No data fetching or diff logic yet — just the shell, `loading`/`error`/`previousText`/`currentText` refs declared but unused.

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Compare a revision against the one before it (Priority: P1) 🎯 MVP

**Goal**: From the History tab, clicking "Diff" on a revision (that has a predecessor) opens a
read-only view showing additions/removals between it and the immediately preceding revision.

**Independent Test**: With at least two revisions loaded in the History tab, click "Diff" on the
later one; verify a diff view opens showing added/removed/unchanged text distinctly, and that
closing it returns to the History tab with no change to revisions, proposals, or document state.

### Tests for User Story 1

- [X] T003 [P] [US1] Component test in `app/frontend/tests/component/RevisionDiffViewer.spec.ts`: given a mocked `useDocumentStore().exportRevision` returning different text for `previousRevision` vs `revision`, mount `RevisionDiffViewer.vue` and assert it renders distinct added/removed/unchanged markers (FR-004); assert emitting `close` fires the `close` event with no store mutation calls other than the two `exportRevision` reads (FR-005, FR-008).
- [X] T004 [P] [US1] Component test in `app/frontend/tests/component/HistoryPanel.spec.ts`: given `store.revisions` includes at least revisions `1` and `2`, assert the row for revision `2` renders a "Diff" button, and clicking it mounts `RevisionDiffViewer` with `revision=2` and `previous-revision=1` props.

### Implementation for User Story 1

- [X] T005 [US1] In `app/frontend/src/components/diff/RevisionDiffViewer.vue`, implement `load()`: on mount and on `revision`/`previousRevision` prop change, call `useDocumentStore().exportRevision(previousRevision)` and `.exportRevision(revision)` (in parallel via `Promise.all`), populate `previousText`/`currentText`, set `loading`/`error` appropriately; on any rejection, set a user-facing `error` message and leave `previousText`/`currentText` null (FR-003, FR-006). (Depends on T002.)
- [X] T006 [US1] In `app/frontend/src/components/diff/RevisionDiffViewer.vue`, add a `diffParts` computed using `diffLines` from the existing `diff` package on `previousText`/`currentText`; render each part as unchanged text, or `<ins>`/`<del>` for added/removed (matching the color/marker convention already used in `DiffViewer.vue`'s `.added`/`.removed` styles); when `diffParts` contains no added/removed parts, render a "No differences found" message instead (FR-007). (Depends on T005.)
- [X] T007 [US1] In `app/frontend/src/components/history/HistoryPanel.vue`, add a `diffingRevision: number | null` ref; render a "Diff" button in each revision row's `.actions` (alongside Restore/Download/Copy) when `rev.revision > 1`, setting `diffingRevision = rev.revision` on click; render `RevisionDiffViewer` inside a `modal-overlay` div (mirroring `EditsList.vue`'s `previewingEditId` pattern) when `diffingRevision !== null`, passing `:revision="diffingRevision"` and `:previous-revision="diffingRevision - 1"`, and clearing `diffingRevision` on `@close`. (Depends on T002; pairs with T005/T006 for a working end-to-end flow.)
- [X] T008 [P] [US1] Playwright e2e scenario in new file `tests/e2e/history-diff.spec.ts`: create a document, make an edit to produce revision `2`, open the History tab, click "Diff" on `v2`, assert added/removed content is visible, close the diff view, and assert the History tab still lists the same revisions (no new revision was created by viewing the diff).

**Checkpoint**: User Story 1 is fully functional and independently testable — reviewers can diff any revision against its predecessor.

---

## Phase 4: User Story 2 - Understand there's nothing to compare for the oldest revision (Priority: P2)

**Goal**: The earliest revision's row never offers a working "Diff" action, since it has no
predecessor.

**Independent Test**: Scroll the History tab to revision `1`; verify no functioning "Diff" action
appears on that row.

### Tests for User Story 2

- [X] T009 [US2] Component test in `app/frontend/tests/component/HistoryPanel.spec.ts`: given `store.revisions` includes revision `1`, assert its row renders no "Diff" button (query by role/name comes back empty for that row specifically).

### Implementation for User Story 2

- [X] T010 [US2] Confirm the `rev.revision > 1` guard added in T007 (`app/frontend/src/components/history/HistoryPanel.vue`) correctly excludes revision `1`; adjust if T007 used a different condition. No new logic expected if T007 was implemented as specified.
- [X] T011 [P] [US2] Extend `tests/e2e/history-diff.spec.ts` (from T008) with a step asserting revision `1`'s row has no "Diff" button.

**Checkpoint**: Both user stories are independently functional — diffing works for any eligible revision, and the ineligible first revision never offers a broken action.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across both stories.

- [X] T012 Run the manual validation scenarios in [quickstart.md](./quickstart.md) end-to-end (including the failed-fetch and identical-revisions edge cases) against a locally running dev build. Scenario 1/2 covered by `tests/e2e/history-diff.spec.ts` running against real (Playwright-managed) backend+frontend dev servers in a real browser; the failed-fetch and identical-revisions edge cases are covered by `RevisionDiffViewer.spec.ts`'s error/identical-text cases (mocking only the store's network call, per the repo's existing component-test convention — same boundary `DiffViewer.vue`'s own tests, if any existed, would mock).
- [X] T013 [P] Run `npm run test:component`, `npm run test:unit` (frontend), and `npm run test:e2e` to confirm all new tests pass and nothing else regressed. `test:component`: 2 files / 7 passed. `test:unit`: no test files exist in `app/frontend/tests/unit` (pre-existing, unrelated to this feature). `test:e2e`: `history-diff.spec.ts` passes in isolation (`--project=history-diff --no-deps`, 1/1); the full suite run (`stories` -> `history-diff`) is blocked by a pre-existing, unrelated flaky failure in `us5.spec.ts` (step 5, "Message Main" composer/isPrimary race) — reproduces identically on a clean run of `us5.spec.ts` alone, confirmed via `git diff --stat` that no file this feature touches is involved. Not a regression from this feature; flagged as a pre-existing issue, not fixed here (out of scope).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS both user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational. No dependency on User Story 2.
- **User Story 2 (Phase 4)**: Depends on Foundational, and in practice on T007 (User Story 1's button/wiring task) since it verifies/adjusts that same conditional — implement Phase 3 before Phase 4.
- **Polish (Phase 5)**: Depends on both user stories being complete.

### Within Each User Story

- Tests are written before their corresponding implementation task where practical (T003/T004 before T005-T007; T009 before T010).
- Component shell (Foundational) before data-fetch/diff logic before wiring into `HistoryPanel.vue`.

### Parallel Opportunities

- T003 and T004 (different test files) can run in parallel.
- T008 (e2e) can be drafted in parallel with T005/T006 (different files), though it won't pass until T005-T007 land.
- T011 and T012/T013 are the only remaining parallelizable tail work.

---

## Parallel Example: User Story 1

```bash
# Launch both User Story 1 test files together:
Task: "Component test for RevisionDiffViewer in app/frontend/tests/component/RevisionDiffViewer.spec.ts"
Task: "Component test for HistoryPanel Diff button in app/frontend/tests/component/HistoryPanel.spec.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001).
2. Complete Phase 2: Foundational (T002).
3. Complete Phase 3: User Story 1 (T003-T008).
4. **STOP and VALIDATE**: Manually diff a revision against its predecessor; confirm added/removed rendering and no side effects on close.
5. This alone is a shippable MVP — reviewers can already diff any revision that has a predecessor; the only gap is that revision 1 might show a button that does nothing meaningful (undefined `previousRevision`), addressed in User Story 2.

### Incremental Delivery

1. Setup + Foundational → component shell ready.
2. User Story 1 → diffing works end-to-end for eligible revisions (MVP).
3. User Story 2 → first revision no longer offers a dead-end action.
4. Polish → full manual + automated validation pass.
