# Implementation Plan: History Revision Diff View

**Branch**: `004-history-diff-view` | **Date**: 2026-08-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-history-diff-view/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Add a "Diff" action to each revision row in the History tab (except the earliest revision) that
opens a read-only view comparing that revision's content against the immediately preceding
revision, with additions/removals visually distinguished. No new backend endpoint or persisted
entity is required: the existing `GET /api/document/export?revision=N` endpoint already returns a
revision's full Markdown text, and the frontend already depends on the `diff` (jsdiff) package
and has a working diff-rendering pattern (`DiffViewer.vue`, `diffWords`) to adapt. This is a
frontend-only change: fetch both revisions' text via the existing export call, diff them
client-side, and render the result in a new diff view opened from `HistoryPanel.vue`.

## Technical Context

**Language/Version**: TypeScript (Vue 3 `<script setup>`), same as rest of `app/frontend`

**Primary Dependencies**: Vue 3, Pinia (`useDocumentStore`), `diff` (jsdiff, already a frontend
dependency — used today by `app/frontend/src/components/diff/DiffViewer.vue` via `diffWords`)

**Storage**: N/A — no new persisted data; reuses existing revision content already retrievable via
`GET /api/document/export?revision=N` (`app/backend/src/server.ts`, documented in
`specs/001-ai-document-review/contracts/http-api.md` §`GET /api/document/export`)

**Testing**: Vitest + `@vue/test-utils` (frontend `package.json` declares `test:component` /
`test:unit` scripts and `jsdom`); note no frontend Vitest test files exist in the repo yet, so
this feature's component/unit tests (if added in `/speckit-tasks`) will be the first under
`app/frontend`. Repo-root Playwright e2e specs also exist (`tests/e2e/*.spec.ts`, run via
`npm run test:e2e`) alongside existing per-user-story specs (`us1.spec.ts`, `us3.spec.ts`, etc.)
— a natural place for an end-to-end scenario covering this feature's User Story 1/2.

**Target Platform**: Browser (existing self-hosted web app frontend)

**Project Type**: Web application (existing `app/backend` + `app/frontend` + `app/shared` layout)

**Performance Goals**: Diff renders within 2s for typical review-sized documents (SC-004); no
new network round trips beyond the two existing per-revision export fetches

**Constraints**: Read-only (FR-008); must not alter document/revision/proposal state; must degrade
to a clear error state if either revision's content fails to load (FR-006)

**Scale/Scope**: Single document, single user (per existing v1 constitution constraints); diff is
between exactly two adjacent revisions per invocation, no multi-revision or range diffing

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. The Application Owns the Document** — PASS. This feature only reads revision content
  through the existing backend-owned export endpoint; it introduces no alternate source of
  document truth.
- **II. Pi Owns Agent Conversations** — N/A. No Pi/conversation interaction involved.
- **III. Agent Edits Are Proposals, Not Direct Writes** — N/A. No document mutation of any kind;
  the feature is strictly read-only (FR-008).
- **IV. CRDT-Mediated Merging, With Revisions as a Separate Concept** — PASS. Uses the existing
  logical-revision concept as-is (diffing revision N against N−1); does not touch the CRDT layer,
  does not add, delete, or reorder revisions.
- **V. Configurable Limits Are Enforced, Not Advisory** — N/A. No new limit is introduced.
- **VI. Sanitize Before Render** — PASS with note: diff output is rendered as plain text spans
  (word/line diff tokens), not through the Markdown/HTML rendering pipeline, matching how
  `DiffViewer.vue` already renders `hunk.contextBefore`/`part.value` as text content (Vue
  auto-escapes interpolated text; no `v-html` is used). Must carry this forward in the new diff
  view — no `v-html` on diffed content.
- **VII. No Pi Extension Without Demonstrated Necessity** — N/A. No Pi involvement.
- **UI Conventions (3-section row layout)** — N/A for this row type: that convention is scoped to
  "conversation rows and headers" (HUD list, conversation detail header); the History tab's
  revision rows are a distinct row type with an existing multi-button `.actions` row (Restore,
  Download, Copy) that this feature extends with one more action, consistent with the existing
  pattern in `HistoryPanel.vue` rather than the conversation-row convention.

No violations. Nothing to record in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/004-history-diff-view/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command) — none needed, see below
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
app/
├── frontend/
│   └── src/
│       └── components/
│           ├── history/
│           │   └── HistoryPanel.vue        # existing — add "Diff" button per eligible revision row
│           └── diff/
│               ├── DiffViewer.vue          # existing — proposal-hunk diff (unchanged)
│               └── RevisionDiffViewer.vue  # new — full-revision-pair diff view (this feature)
├── backend/            # no changes — reuses existing GET /api/document/export?revision=N
└── shared/             # no changes — no new contract type needed

tests/
└── e2e/                # existing Playwright suite — candidate location for a new scenario spec
```

**Structure Decision**: Frontend-only change within the existing `app/frontend` Vue/Pinia
structure. A new `RevisionDiffViewer.vue` component (sibling to the existing `DiffViewer.vue` in
`app/frontend/src/components/diff/`) is opened from `HistoryPanel.vue`; it fetches both
revisions' text via `useDocumentStore().exportRevision()` (already wraps
`GET /api/document/export?revision=N`) and renders the diff using the already-installed `diff`
package. No backend or shared-contract changes are needed.

## Complexity Tracking

No Constitution Check violations — this section is not applicable.
