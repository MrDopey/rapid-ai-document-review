# Phase 1 Data Model: History Revision Diff View

No new persisted entity, database table, or shared contract type is introduced by this feature
(see [research.md](./research.md), "No new shared contract type"). This document describes the
transient, client-side view model used to render a diff, built entirely from data already
available.

## Existing entities used (unchanged)

### Revision (`RevisionDto`, `app/shared/src/contracts/http.ts`)

Already defined and already loaded into `useDocumentStore().revisions` by `HistoryPanel.vue`. This
feature reads, but does not modify, this entity or its schema.

| Field | Type | Used by this feature for |
|---|---|---|
| `revision` | `number` (int) | Identifying which revision to diff, and computing its predecessor (`revision - 1`) |
| `createdAt` | `string` | Not used directly by the diff view (already shown in the history row) |
| *(all other fields)* | — | Not used by the diff view |

**Diff eligibility rule** (FR-001/FR-002): a revision entry offers a working "Diff" action if and
only if `revision > 1`. Revision numbers are contiguous with no gaps (confirmed in research.md), so
no lookup is needed to know whether a predecessor exists.

## New transient view state (not persisted)

### `RevisionDiffRequest` (component prop, not a shared type)

Passed from `HistoryPanel.vue` to the new `RevisionDiffViewer.vue` when a "Diff" action is
activated.

| Field | Type | Description |
|---|---|---|
| `revision` | `number` | The selected revision (must be `> 1`) |
| `previousRevision` | `number` | Always `revision - 1` |

### `RevisionDiffViewState` (internal component state)

| Field | Type | Description |
|---|---|---|
| `loading` | `boolean` | True while either revision's text is being fetched |
| `error` | `string \| null` | Set if either `exportRevision()` call fails (FR-006) |
| `previousText` | `string \| null` | Content of `previousRevision`, once loaded |
| `currentText` | `string \| null` | Content of `revision`, once loaded |
| `diffParts` | `Change[] \| null` (from `diff`'s `diffLines`) | Computed once both texts are loaded; `null` while loading/error |
| `identical` | `boolean` | Derived: true when `diffParts` contains no added/removed parts (FR-007) |

No field here is persisted beyond the lifetime of the open diff view; closing it (FR-005) discards
this state with no side effects on `Revision`, staged edits, or document content.
