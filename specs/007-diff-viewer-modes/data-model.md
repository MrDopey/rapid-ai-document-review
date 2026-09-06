# Data Model: Proposed-Edit Diff Highlighting & Side-by-Side View

This feature adds no persisted fields, tables, or backend contract changes (per spec.md's Key
Entities and Assumptions). The entities below are render-time-only, client-side concepts.

## Proposed Edit Preview (existing, unchanged)

Source: `PreviewEditResponse` (`app/shared/src/contracts/http.ts`) — already fetched today by
`DiffViewer.vue` via `httpClient.previewEdit(editId)`. No fields are added or changed by this
feature.

| Field | Type | Notes |
|---|---|---|
| `stagedEditId` | `string` | unchanged |
| `reconcilable` | `boolean` | unchanged; `false` continues to force the conflict banner over all views (FR-009) |
| `fullPreview` | `string \| null` | unchanged; the proposed/reconciled full document text |
| `hunks` | `EditHunk[]` | unchanged; feeds the existing "Added / removed" view |
| `conflictDetail` | `ConflictDetail \| null` | unchanged |

## Original Document Snapshot (new, ephemeral, client-only)

A plain `string`, held in a local `ref` inside `DiffViewer.vue`, captured from
`useDocumentStore().content` at the same moment `preview` is fetched (inside `load()`). Not
persisted, not part of any API contract. Exists only for the lifetime of one open preview dialog;
discarded when the dialog unmounts or a new `editId` triggers a fresh `load()`.

- **Purpose**: supplies the "original" side of the Full-document and Side-by-side comparisons,
  which `PreviewEditResponse` does not carry (see research.md R2).
- **Lifecycle**: set once per `load()` call; not re-read reactively from the store afterward, so it
  stays paired with the `fullPreview` snapshot it was fetched alongside.

## View Mode (new, ephemeral, client-only)

An enum-like ref: `'hunks' | 'full' | 'side-by-side'`.

- **Default**: `'hunks'` (FR-004 / User Story 3) — unchanged from today's default, extended with one
  new value.
- **Scope**: local component state in `DiffViewer.vue`; not persisted across dialog open/close
  (spec.md Assumptions, line 106) and not synced anywhere else.
- **Transitions**: any value ↔ any value, freely, driven only by the reviewer clicking a tab;
  switching never triggers a new fetch (FR-006) and never mutates `preview` or the original
  snapshot.

## Diff Segment (existing concept, now reused across more views)

Source: `Change` objects returned by the `diff` package's `diffWords(a, b)` (already the shape used
by the existing hunk view; see research.md R1). Not persisted; recomputed via a `computed()` each
time `preview`, the original snapshot, or a hunk's before/after changes.

| Field | Type | Meaning |
|---|---|---|
| `value` | `string` | the literal text of this segment |
| `added` | `boolean?` | present only on segments only in the proposed text |
| `removed` | `boolean?` | present only on segments only in the original text |

Five call sites now produce `Change[]` arrays from this same shape, across two components:

1. **Hunks** (`DiffViewer.vue`, existing, unchanged): one `Change[]` per hunk —
   `diffWords(hunk.removed, hunk.added)`.
2. **Full document** (`DiffViewer.vue`, new): one `Change[]` —
   `diffWords(originalSnapshot, preview.fullPreview ?? '')`.
3. **Side by side** (`DiffViewer.vue`, new): reuses the same `Change[]` as Full document; the left
   column renders it filtered to `unchanged | removed` segments, the right column filtered to
   `unchanged | added` segments (see `DiffText.vue` below) — the comparison is computed once, not
   twice.
4. **Unified** (`RevisionDiffViewer.vue`, existing, rendering migrated to `DiffText.vue`): one
   `Change[]` — `diffLines(previousText, currentText)` (granularity unchanged from today; see
   research.md R9).
5. **Side by side** (`RevisionDiffViewer.vue`, new): reuses the same `Change[]` as its Unified view;
   left column filtered to `unchanged | removed`, right column filtered to `unchanged | added` —
   same filtering rule as (3), applied to `RevisionDiffViewer.vue`'s own already-fetched
   `previousText`/`currentText`, with no new fetch (FR-014).

### No-diff state (FR-007)

Derived, not a separate stored entity: a view is "no differences found" when its `Change[]` is
`[{ value: <text> }]` with neither `added` nor `removed` set (i.e. length 1, both flags falsy).

## View Mode — `RevisionDiffViewer.vue` (new, ephemeral, client-only)

An enum-like ref: `'unified' | 'side-by-side'`, mirroring `DiffViewer.vue`'s `view` ref (see above)
but scoped to `RevisionDiffViewer.vue`'s own, smaller set of view modes (it has no hunks/full-document
distinction — it already compares two whole revisions).

- **Default**: `'unified'` (FR-013) — `RevisionDiffViewer.vue`'s current, only display becomes the
  default of two.
- **Scope**: local component state; not persisted, not synced with `DiffViewer.vue`'s `view` state
  (these are two independent dialogs/components that happen to share the `DiffText.vue` rendering
  component, not shared UI state).

## Internal Component: `DiffText.vue` (new, shared by both `DiffViewer.vue` and `RevisionDiffViewer.vue`)

Not a data entity, but the shared unit all diff segments in the app now flow through; documented
here because it is the shape all five call sites above conform to.

| Prop | Type | Meaning |
|---|---|---|
| `parts` | `Change[]` | the diff segments to render |
| `side` | `'unified' \| 'left' \| 'right'` | `'unified'` renders every segment (`DiffViewer.vue` hunks and full-document; `RevisionDiffViewer.vue` unified view); `'left'` renders only `unchanged`/`removed` segments (either component's side-by-side original/earlier column); `'right'` renders only `unchanged`/`added` segments (either component's side-by-side proposed/later column) |

Renders each included segment as `<del>`/`<ins>`/`<span>` with the existing marker glyph +
`.visually-hidden` label treatment. For `DiffViewer.vue` this is unchanged from today's hunk-view
markup (FR-010). For `RevisionDiffViewer.vue` this is new — it replaces that component's current,
simpler `<del>`/`<ins>`/`<span>`-with-no-marker-or-label markup (FR-011; see research.md R4).
