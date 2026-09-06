# Implementation Plan: Proposed-Edit Diff Highlighting & Side-by-Side View

**Branch**: `007-diff-viewer-modes` | **Date**: 2026-09-06 | **Spec**: `specs/007-diff-viewer-modes/spec.md`

**Input**: Feature specification from `/specs/007-diff-viewer-modes/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Extend `DiffViewer.vue`'s existing "Added / removed" / "Full document" tab toggle so "Full document"
shows the same word-level added/removed highlighting as the hunk view (today it renders an
undifferentiated plain-text block), and add a third "Side by side" view showing the original and
proposed document in two independently-scrollable columns with the same per-side highlighting.
"Added / removed" remains the default view. All diff rendering continues to use Vue text
interpolation (never `v-html`) so HTML-significant characters are always literal, never markup.
No backend or API contract changes are required: the original document text needed for the new
views already exists client-side in `useDocumentStore()`, and the existing `diff` npm package
(`diffWords`) already used by the hunk view is reused as-is. A new shared `DiffText.vue`
presentational component removes what would otherwise be a third/fourth copy of the hunk view's
`<del>/<ins>/<span>` + accessibility-label markup — and is also adopted by the separate, already-
shipped revision-history comparison view (`RevisionDiffViewer.vue`), which gains the same
marker-glyph/screen-reader-label treatment and its own "Side by side" view mode alongside its
existing unified display, so both diff experiences in the app share one consistent, accessible
rendering implementation (User Story 4, FR-011..FR-014).

## Technical Context

**Language/Version**: TypeScript (Vue 3 `<script setup>`), matching the existing frontend stack.

**Primary Dependencies**: Vue 3, Pinia (`useDocumentStore`), `diff` (`^9.0.0`, already a dependency —
`diffWords`), existing `httpClient.previewEdit`. No new dependency is introduced.

**Storage**: N/A — no persisted data changes; all new state (view mode, original-text snapshot,
computed diff segments) is ephemeral, component-local.

**Testing**: Vitest + `@vue/test-utils` + Pinia test doubles, matching the existing convention in
`app/frontend/tests/component/RevisionDiffViewer.spec.ts` and `EditsList.spec.ts`.

**Target Platform**: Browser frontend (existing self-hosted, Dockerized deployment; no platform change).

**Project Type**: Web application (frontend-only change within the existing `app/frontend` +
`app/backend` structure — no backend changes).

**Performance Goals**: Diff rendering (any view mode) completes within 2 seconds for a typical
review-size document (SC-004); reuses the already-adequate `diffWords` performance characteristics
of the existing hunk view, applied to whole-document-sized inputs instead of per-hunk-sized inputs.

**Constraints**: Switching view modes MUST NOT trigger a new network request (FR-006); the
Side-by-side view MUST remain readable at this app's existing narrow constrained-pane widths
without page-level horizontal scroll (FR-008); every view MUST escape HTML-significant characters
(FR-005) via the existing text-interpolation pattern, not a new sanitizer.

**Scale/Scope**: Two existing components extended (`DiffViewer.vue`, `RevisionDiffViewer.vue`), one
new small presentational component (`DiffText.vue`) shared by both, one new component test file
(`DiffViewer.spec.ts`) plus targeted updates to the existing `RevisionDiffViewer.spec.ts` to account
for `DiffText.vue`'s marker/label markup and the new side-by-side view mode. No backend, contract,
or other feature area beyond these two diff-rendering components is touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle VI (Sanitize Before Render)**: Satisfied by construction — every view continues to
  render diffed text via Vue text interpolation inside `<del>/<ins>/<span>`, never `v-html`; no new
  sanitizer or rendering-format extension is introduced (see research.md R3). PASS.
- **Principle I (The Application Owns the Document)**: No document mutation of any kind — this
  feature is entirely read-only rendering of already-fetched preview data and the document store's
  existing, already-loaded content. PASS.
- **Principle V (Configurable Limits Are Enforced, Not Advisory)**: No new limit is introduced or
  bypassed by this feature. N/A.
- **Quality & Review Gates**: All three user stories already have Given/When/Then acceptance
  scenarios in spec.md before implementation begins. PASS. No idempotency, browser-disconnect, or
  seed-message concerns apply — this feature adds no server-side operation and no LLM-facing content.
- **UI Conventions (conversation row/header 3-section layout, keyboard shortcuts registry)**: Not
  applicable — `DiffViewer.vue` is a preview dialog, not a conversation row/header, and no new
  global keyboard shortcut is introduced (the view-mode tabs are local, mouse/keyboard-focusable
  buttons within the existing tablist, not a registry-tracked shortcut).
- **CSS reuse**: `app/frontend/src/style.css` was read as part of Phase 0 research (research.md R6).
  Existing shared utilities `.text-wrap-safe-pre` and `.visually-hidden` are reused as-is; no
  existing two-column/grid utility exists to reuse, and the new Side-by-side column layout has a
  single consumer today, so per this project's existing hoist-on-2nd/3rd-use convention it stays
  scoped locally in `DiffViewer.vue` rather than being added to `style.css`.

- **Cross-feature touch (`RevisionDiffViewer.vue`, feature `004-history-diff-view`)**: This plan
  deliberately modifies a component belonging to a different, already-shipped feature, at explicit
  user direction (parity between the two diff experiences). This is not a constitution violation —
  no principle restricts touching a prior feature's component — but it is called out here because it
  is a wider blast radius than a typical single-feature plan: `RevisionDiffViewer.spec.ts`'s existing
  assertions must continue to pass (or be updated like-for-like, never loosened past what still
  proves FR-011/FR-014) alongside this change (see research.md R4).

No violations requiring the Complexity Tracking table.

**Post-Phase-1 re-check**: The Phase 1 design (data-model.md, contracts/diff-text-component.md)
introduces only client-local, ephemeral state and one internal presentational component shared by
two components; it does not change any conclusion above. PASS.

## Project Structure

### Documentation (this feature)

```text
specs/007-diff-viewer-modes/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md         # Phase 1 output (/speckit-plan command)
├── contracts/            # Phase 1 output (/speckit-plan command)
│   └── diff-text-component.md
├── checklists/
│   └── requirements.md   # already present, all green
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
app/frontend/
├── src/
│   └── components/
│       └── diff/
│           ├── DiffViewer.vue          # extended: 3rd tab/panel, full-doc + side-by-side diffing
│           ├── DiffText.vue             # new: shared <del>/<ins>/<span> + a11y-label renderer
│           └── RevisionDiffViewer.vue   # extended: migrated to DiffText.vue, gains side-by-side tab
└── tests/
    └── component/
        ├── DiffViewer.spec.ts           # new: covers all three view modes + FR-005/006/007
        ├── RevisionDiffViewer.spec.ts    # updated: DiffText.vue markup + side-by-side (FR-011..014)
        └── EditsList.spec.ts             # unchanged; still exercises DiffViewer indirectly

app/backend/    # no changes
app/shared/     # no changes (PreviewEditResponse contract unchanged)
```

**Structure Decision**: Existing `frontend` + `backend` web-application layout is unchanged; this
feature is scoped entirely to `app/frontend/src/components/diff/` and its matching test directory,
now spanning both diff-rendering components rather than `DiffViewer.vue` alone. No new top-level
directories, packages, or backend routes are introduced.

## Complexity Tracking

*No violations — table not needed.*
