# Quickstart: History Revision Diff View

Validation guide for the "Diff" action added to the History tab. See [spec.md](./spec.md) for
acceptance scenarios and [data-model.md](./data-model.md) / [research.md](./research.md) for the
underlying design.

## Prerequisites

- Backend and frontend dev servers running (see repo root `README.md` for the standard `npm run
  dev` setup for this project).
- A document with at least two revisions. The fastest way to get there:
  1. Create or open the document.
  2. Make a manual edit and wait for the debounce period (or trigger an agent edit in the Primary
     conversation) so a second revision (`v2`) is recorded.

## Manual validation

### Scenario 1: Diff a revision against its predecessor (User Story 1, P1)

1. Open the History tab.
2. Confirm at least two revisions are listed (e.g. `v1`, `v2`).
3. Click the "Diff" action on `v2`.
4. **Expected**: A diff view opens showing the differences between `v1`'s content and `v2`'s
   content, with added and removed text visually distinguished from unchanged text.
5. Close the diff view.
6. **Expected**: Returns to the History tab with the same revisions still listed; no revision,
   proposal, or document state has changed (spot-check: `v2` is still `currentRevision`, no new
   revision was created by opening/closing the diff).

### Scenario 2: No diff action on the earliest revision (User Story 2, P2)

1. In the History tab, scroll to `v1` (the first revision).
2. **Expected**: No working "Diff" action is present on `v1`'s row.

### Edge case: failed revision fetch

1. Simulate a failure fetching one revision's content (e.g. temporarily stop the backend, or use
   browser devtools to block the `GET /api/document/export?revision=` request for one of the two
   revisions, then trigger the diff).
2. **Expected**: The diff view shows a clear error message rather than a blank or partially
   rendered comparison (FR-006).

### Edge case: identical revisions

1. Find or create two adjacent revisions with no textual difference (e.g. a metadata-only
   revision, if the system produces one).
2. Click "Diff".
3. **Expected**: The diff view indicates no differences were found (FR-007), not an empty-looking
   broken state.

## Automated coverage (for `/speckit-tasks`)

- No frontend Vitest test files exist yet in `app/frontend` (confirmed during planning) — this
  feature is a reasonable place to add the first `tests/component` spec for `RevisionDiffViewer.vue`
  and/or an updated spec for `HistoryPanel.vue`'s new "Diff" button.
- Consider a Playwright e2e scenario alongside the existing per-user-story specs in
  `tests/e2e/*.spec.ts` covering Scenario 1 and Scenario 2 above end-to-end.
