---

description: "Task list template for feature implementation"
---

# Tasks: Proposed-Edit Diff Highlighting & Side-by-Side View

**Input**: Design documents from `/specs/007-diff-viewer-modes/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/diff-text-component.md, quickstart.md (all present)

**Tests**: Included — this codebase's two existing sibling diff components (`RevisionDiffViewer.vue`,
`EditsList.vue`) both have dedicated Vitest component-test files, and the constitution's Quality &
Review Gates require every user-facing behavior change to map to Given/When/Then acceptance criteria
before implementation is considered complete. Tasks below follow that established convention.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P4) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- File paths are exact and repo-relative

## Path Conventions

This is the existing `app/frontend` + `app/backend` web-application layout (unchanged by this
feature — see plan.md Project Structure). All tasks below are under `app/frontend/`.

---

## Phase 1: Setup

**No setup tasks required.** No new dependency is introduced (`diff@^9.0.0` is already installed;
see research.md R1), no new top-level directory is created, and no build/lint/tooling configuration
changes. Proceed directly to Phase 2.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce the shared `DiffText.vue` rendering component that every user story below
depends on (see research.md R4, data-model.md, contracts/diff-text-component.md).

**⚠️ CRITICAL**: No user story task may begin until this phase is complete.

- [X] T001 Create `DiffText.vue` in `app/frontend/src/components/diff/DiffText.vue` implementing the `DiffTextProps` contract (`parts: Change[]`, `side: 'unified' | 'left' | 'right'`) from `specs/007-diff-viewer-modes/contracts/diff-text-component.md`: render each included segment as `<del class="removed">`/`<ins class="added">`/`<span>` with the marker glyph (`aria-hidden="true"`) and `.visually-hidden` "removed:"/"added:" label, always via `{{ part.value }}` text interpolation (never `v-html`); `side="left"` filters to `!part.added`, `side="right"` filters to `!part.removed`, `side="unified"` renders every part; include the `.removed`/`.added`/`.marker` scoped CSS rules (moved here as the single source per research.md R4/R9) using the existing `--danger-color`/`--danger-bg`/`--success-color`/`--success-bg` custom properties
- [X] T002 Create `app/frontend/tests/component/DiffText.spec.ts`: mount `DiffText.vue` directly with sample `Change[]` fixtures and assert (a) `side="unified"` renders every part in order with correct `<del>`/`<ins>`/`<span>` + marker + visually-hidden-label per FR-010's existing treatment, (b) `side="left"` omits added-only parts, `side="right"` omits removed-only parts, (c) a part containing `<`, `>`, `&` renders as literal text in `wrapper.html()` (never as unescaped markup) — validates FR-005/SC-002 at the shared-component level

**Checkpoint**: `DiffText.vue` exists, is unit-tested, and is ready to be consumed by both `DiffViewer.vue` (US1/US2/US3) and `RevisionDiffViewer.vue` (US4).

---

## Phase 3: User Story 1 - See highlighted changes across the whole document (Priority: P1) 🎯 MVP

**Goal**: The "Full document" view in `DiffViewer.vue` shows word-level added/removed highlighting instead of an undifferentiated plain-text block, with a "No differences found" fallback for no-op edits.

**Independent Test**: Open a proposed edit's preview, switch to "Full document," and verify added/removed text are visually distinguished while unchanged text is plain (spec.md User Story 1 Independent Test).

### Tests for User Story 1

- [X] T003 [P] [US1] Create `app/frontend/tests/component/DiffViewer.spec.ts` (new file; none exists today — see research.md R8) covering: Full-document view renders `.added`/`.removed` nodes for a diffing original/proposed pair; a document containing `<script>`, `<b>`, `&amp;` renders those characters literally (`wrapper.html()` assertion) in the Full-document view; a no-op edit (identical original/proposed) shows a "No differences found" message instead of plain text in the Full-document view; the existing hunk view's `.added`/`.removed` output is unchanged after the `DiffText.vue` migration (FR-010 regression guard)

### Implementation for User Story 1

- [X] T004 [US1] In `app/frontend/src/components/diff/DiffViewer.vue`, import `useDocumentStore` and add a local `originalSnapshot = ref('')`, set once inside `load()` from `useDocumentStore().content` at the same point `preview` is fetched (research.md R2) — do not read `store.content` reactively elsewhere in the component
- [X] T005 [US1] In `DiffViewer.vue`, add `fullDocDiff = computed(() => diffWords(originalSnapshot.value, preview.value?.fullPreview ?? ''))` and a derived `fullDocHasNoDiff = computed(() => fullDocDiff.value.length === 1 && !fullDocDiff.value[0].added && !fullDocDiff.value[0].removed)` (research.md R5, data-model.md "No-diff state")
- [X] T006 [US1] In `DiffViewer.vue`, replace the Full-document panel's `<pre class="text-wrap-safe-pre">{{ preview.fullPreview }}</pre>` with: a "No differences found." status message when `fullDocHasNoDiff` is true, otherwise `<pre class="text-wrap-safe-pre"><DiffText :parts="fullDocDiff" side="unified" /></pre>` (FR-001, FR-007)
- [X] T007 [US1] In `DiffViewer.vue`, migrate the existing hunk view's per-hunk `<del>/<ins>/<span>` template block to `<DiffText :parts="wordDiffs[i]" side="unified" />` (one per hunk), removing the now-redundant inline markup — must not change the hunk view's rendered output (FR-010)
- [X] T008 [US1] In `DiffViewer.vue`'s `<style scoped>` block, remove the now-duplicated `.removed`/`.added`/`.marker` rules (owned by `DiffText.vue` since T001); keep only rules still needed locally (e.g. panel/tab layout)

**Checkpoint**: User Story 1 is fully functional and independently testable — "Full document" shows real highlighting, hunk view is unchanged, no-op edits show the no-diff message.

---

## Phase 4: User Story 2 - Compare before and after side by side (Priority: P2)

**Goal**: A new "Side by side" tab in `DiffViewer.vue` shows the original and proposed document in two independently-scrollable, per-side-highlighted columns.

**Independent Test**: Open a proposed edit's preview, select "Side by side," and verify two columns appear with per-column highlighting (spec.md User Story 2 Independent Test).

### Tests for User Story 2

- [X] T009 [P] [US2] Extend `app/frontend/tests/component/DiffViewer.spec.ts`: selecting "Side by side" renders two columns; the left column shows only removed/unchanged segments, the right column shows only added/unchanged segments; a no-op edit shows "No differences found" in this view too; switching hunks → side-by-side → full-document → hunks calls `httpClient.previewEdit` exactly once total (FR-006)

### Implementation for User Story 2

- [X] T010 [US2] In `DiffViewer.vue`, extend `view = ref<'full' | 'hunks'>('hunks')` to `ref<'full' | 'hunks' | 'side-by-side'>('hunks')` and add a third tab button (`id="diff-tab-side-by-side"`, `aria-controls="diff-panel-side-by-side"`) to the existing `role="tablist"` toggle, following the same pattern as the existing two tabs (research.md R7)
- [X] T011 [US2] In `DiffViewer.vue`, add the `role="tabpanel"` Side-by-side panel (`id="diff-panel-side-by-side"`, `aria-labelledby="diff-tab-side-by-side"`, `tabindex="0"`, toggled via the `hidden` attribute like the other two panels — not `v-if`), containing two columns: left `<DiffText :parts="fullDocDiff" side="left" />`, right `<DiffText :parts="fullDocDiff" side="right" />` (reuses the `fullDocDiff` computed from T005 — no second diff computation), each showing the same "No differences found" fallback as Full-document when `fullDocHasNoDiff` is true
- [X] T012 [US2] In `DiffViewer.vue`'s `<style scoped>` block, add a two-column CSS grid (`grid-template-columns: 1fr 1fr`) for the Side-by-side panel, with each column independently `overflow: auto` and reusing the existing `.text-wrap-safe-pre` utility class for wrapping (research.md R6) — scoped locally, not hoisted to `style.css` (single consumer)

**Checkpoint**: User Stories 1 AND 2 both work independently in `DiffViewer.vue`.

---

## Phase 5: User Story 3 - Default view stays compact and inline (Priority: P3)

**Goal**: The preview always opens on "Added / removed" (inline), never "Side by side," regardless of a prior selection on a different proposal.

**Independent Test**: Open any proposed edit's preview and verify it opens on "Added / removed" (spec.md User Story 3 Independent Test).

### Tests for User Story 3

- [X] T013 [P] [US3] Extend `app/frontend/tests/component/DiffViewer.spec.ts`: a freshly mounted `DiffViewer` (fresh `editId` prop, simulating `EditsList.vue`'s mount-per-open pattern) always starts with `view === 'hunks'`; after simulating a user selecting "Side by side," then re-mounting the component for a different `editId`, `view` is back to `'hunks'`

### Implementation for User Story 3

- [X] T014 [US3] In `DiffViewer.vue`, confirm `view` is declared with its `ref('hunks')` default and is never persisted (e.g. no `localStorage`/store read at init) so that `EditsList.vue`'s existing mount-per-open pattern (`v-if="previewingEditId"`) naturally resets it on every new preview — no production code change expected if T010 preserved this; this task exists to make the guarantee explicit and verified by T013, not to add new logic

**Checkpoint**: All three `DiffViewer.vue` view modes now work together, defaulting correctly.

---

## Phase 6: User Story 4 - Consistent diff experience when reviewing revision history (Priority: P4)

**Goal**: `RevisionDiffViewer.vue` (a different, already-shipped feature) renders through the same `DiffText.vue` component as `DiffViewer.vue` and gains its own "Side by side" view, defaulting to its existing unified display.

**Independent Test**: Open the revision-history comparison view, verify its markup matches `DiffViewer.vue`'s marker+label treatment, and verify "Side by side" is available and behaves consistently (spec.md User Story 4 Independent Test).

### Tests for User Story 4

- [X] T015 [US4] Update `app/frontend/tests/component/RevisionDiffViewer.spec.ts`: loosen any assertion on `<ins>`/`<del>`'s exact `innerHTML` to assert on text content / class presence instead (to tolerate `DiffText.vue`'s new marker-glyph/visually-hidden-label child nodes — a like-for-like update, not a weakened check, per plan.md's Constitution Check note); add assertions for the marker glyph and visually-hidden label now present (FR-011); add assertions that selecting "Side by side" renders two columns filtered the same way as `DiffViewer.vue`'s (FR-012); assert the view defaults to `'unified'` and resets on a new revision comparison (FR-013); assert no additional `store.exportRevision` (or equivalent fetch) call occurs when switching view modes (FR-014)

### Implementation for User Story 4

- [X] T016 [US4] In `RevisionDiffViewer.vue`, replace the existing inline `<del class="removed">{{ part.value }}</del>` / `<ins class="added">{{ part.value }}</ins>` / `<span>{{ part.value }}</span>` loop with `<DiffText :parts="diffParts" side="unified" />`, keeping `diffParts = computed(() => diffLines(previousText.value, currentText.value))` unchanged (granularity stays `diffLines`, per research.md R9 — do not switch to `diffWords`)
- [X] T017 [US4] In `RevisionDiffViewer.vue`, add `view = ref<'unified' | 'side-by-side'>('unified')` and a two-tab `role="tablist"` toggle (mirroring `DiffViewer.vue`'s pattern from T010), with both panels mounted and toggled via the `hidden` attribute
- [X] T018 [US4] In `RevisionDiffViewer.vue`, add the Side-by-side panel: two columns reusing the same `diffParts` computed — left `<DiffText :parts="diffParts" side="left" />`, right `<DiffText :parts="diffParts" side="right" />` — with the same two-column CSS grid approach as `DiffViewer.vue` (mirrors T012)
- [X] T019 [US4] In `RevisionDiffViewer.vue`'s `<style scoped>` block, remove the now-duplicated `.removed`/`.added`/`.marker` rules (owned by `DiffText.vue` since T001), keeping only rules still needed locally (e.g. the new grid layout from T018)

**Checkpoint**: Both diff experiences in the app (`DiffViewer.vue` and `RevisionDiffViewer.vue`) share identical rendering/accessibility treatment via `DiffText.vue`, and both offer a side-by-side option.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Verify the whole feature end-to-end, across both components, with no regressions.

- [X] T020 [P] Run `npx vitest run tests/component` (full suite) in `app/frontend` — confirm `DiffViewer.spec.ts`, `DiffText.spec.ts`, `RevisionDiffViewer.spec.ts`, and `EditsList.spec.ts` all pass with no regressions
- [X] T021 Execute the manual validation steps in `specs/007-diff-viewer-modes/quickstart.md` (all 6 sections, covering US1–US4 and edge cases) against a running dev instance
- [X] T022 [P] Performance sanity check: with a typical-size review document, confirm Full-document and Side-by-side rendering (both components) completes within ~2 seconds of selecting the tab (SC-004)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies — start immediately. BLOCKS all user stories (T004–T019 all consume `DiffText.vue`).
- **User Story 1 (Phase 3)**: Depends on Phase 2 only.
- **User Story 2 (Phase 4)**: Depends on Phase 2 and on T005 (`fullDocDiff` computed) from Phase 3 — implemented in the same file (`DiffViewer.vue`) right after US1, not independently parallelizable with US1's implementation tasks.
- **User Story 3 (Phase 5)**: Depends on Phase 2 and on T010 (the `view` ref extension) from Phase 4, but is otherwise a verification pass, not new logic.
- **User Story 4 (Phase 6)**: Depends on Phase 2 only — does NOT depend on US1/US2/US3 (a different file, `RevisionDiffViewer.vue`); can be implemented in parallel with Phases 3–5 by a different contributor once Phase 2 is done.
- **Polish (Phase 7)**: Depends on all four user stories being complete.

### Within Each User Story

- Tests are written before implementation and should fail first (T003 before T004–T008; T009 before T010–T012; T013 before T014; T015 before T016–T019).
- All of US1/US2/US3's implementation tasks edit the same file (`DiffViewer.vue`) — strictly sequential, no `[P]`.
- All of US4's implementation tasks edit the same file (`RevisionDiffViewer.vue`) — strictly sequential, no `[P]`.

### Parallel Opportunities

- T001 and T002 in Foundational are sequential (the test needs the component to exist), not parallel.
- Once Phase 2 is done, **User Story 4 (Phase 6, `RevisionDiffViewer.vue`)** can proceed entirely in parallel with **User Stories 1–3 (Phases 3–5, `DiffViewer.vue`)** — different files, no shared state.
- T020 and T022 in Polish can run in parallel with each other (independent checks); T021 (manual validation) should run after both.

---

## Parallel Example: After Foundational Completes

```bash
# Two contributors can work simultaneously:
# Contributor A: DiffViewer.vue track
Task: "T003 Create DiffViewer.spec.ts with Full-document tests"
Task: "T004-T008 Implement Full-document highlighting in DiffViewer.vue"
Task: "T009-T012 Implement Side-by-side in DiffViewer.vue"
Task: "T013-T014 Verify default-view behavior"

# Contributor B: RevisionDiffViewer.vue track (independent file)
Task: "T015 Update RevisionDiffViewer.spec.ts for DiffText.vue + side-by-side"
Task: "T016-T019 Migrate RevisionDiffViewer.vue to DiffText.vue and add side-by-side"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (`DiffText.vue`)
2. Complete Phase 3: User Story 1 (Full-document highlighting)
3. **STOP and VALIDATE**: Run T003's tests + quickstart.md User Story 1 section independently
4. Deploy/demo if ready — this alone fixes the "Full document shows zero diff signal" gap called out in spec.md as the most direct problem today

### Incremental Delivery

1. Foundational → Foundation ready
2. Add User Story 1 → validate → deploy (MVP)
3. Add User Story 2 → validate → deploy
4. Add User Story 3 → validate → deploy
5. Add User Story 4 (can be done any time after Foundational, independently of 1–3) → validate → deploy
6. Polish phase confirms no cross-story/cross-component regressions

## Notes

- `[P]` tasks touch different files and have no incomplete-task dependency.
- `[Story]` labels map each task to its spec.md user story for traceability.
- US4 is the one story that is fully decoupled from the others (different component file) — it is genuinely parallelizable with the rest, not just nominally independent.
- Commit after each task or logical group; verify tests fail before implementing them.
