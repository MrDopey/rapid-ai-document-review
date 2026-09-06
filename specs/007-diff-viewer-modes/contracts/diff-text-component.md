# Contract: `DiffText.vue` (internal component interface)

## No external/backend contract changes

This feature adds no HTTP endpoints and no changes to any existing request/response schema in
`app/shared/src/contracts/http.ts`. `PreviewEditResponse` is consumed exactly as it is today (see
data-model.md). There is nothing to document under a traditional API contract for this feature.

## Internal interface: `DiffText.vue`

The one new interface this feature introduces is internal and presentational, consumed by both
`DiffViewer.vue` and `RevisionDiffViewer.vue` (see research.md R4/R9). It is the shared seam across
five render sites total: `DiffViewer.vue`'s hunks, full-document, and side-by-side columns, and
`RevisionDiffViewer.vue`'s unified view and side-by-side columns.

### Props

```ts
interface DiffTextProps {
  parts: Change[]; // from the `diff` package: { value: string; added?: boolean; removed?: boolean }[]
  side: 'unified' | 'left' | 'right';
}
```

- `side: 'unified'` — renders every part in `parts`, in order. Used by: `DiffViewer.vue`'s hunk view
  (one `<DiffText>` per hunk) and Full-document view (one `<DiffText>` for the whole document); and
  `RevisionDiffViewer.vue`'s unified view (one `<DiffText>` for the whole revision comparison).
- `side: 'left'` — renders only parts where `!part.added` (i.e. `removed` or unchanged). Used by
  both components' Side-by-side view's original/earlier (left) column.
- `side: 'right'` — renders only parts where `!part.removed` (i.e. `added` or unchanged). Used by
  both components' Side-by-side view's proposed/later (right) column.

### Rendering guarantee

For every included part:
- `part.removed` → `<del class="removed"><span class="marker" aria-hidden="true">−</span><span class="visually-hidden">removed:</span>{{ part.value }}</del>`
- `part.added` → `<ins class="added"><span class="marker" aria-hidden="true">+</span><span class="visually-hidden">added:</span>{{ part.value }}</ins>`
- otherwise → `<span>{{ part.value }}</span>`

`part.value` is always rendered via Vue text interpolation, never `v-html` — this is the load-bearing
guarantee for FR-005/SC-002 and must not change without re-verifying HTML escaping across all three
view modes.

### No-diff behavior

`DiffText.vue` itself does not special-case the "no differences" state — FR-007's "No differences
found" message is rendered by the parent panel (Full-document / Side-by-side) when it detects
`parts` reduces to a single unchanged segment (see data-model.md), in place of mounting
`<DiffText>` for that panel.
