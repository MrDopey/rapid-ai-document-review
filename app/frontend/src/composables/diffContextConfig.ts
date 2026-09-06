/**
 * How many unchanged lines of context to keep visible around each change in the "Full document" /
 * "Side by side" / revision-comparison diff views before collapsing the rest — the same idea as
 * the backend's `RADR_BE_HUNK_CONTEXT_LINES` (app/backend/src/edit/preview.ts), but for the
 * whole-document diff views rather than the per-hunk preview text, and read client-side since no
 * backend round trip is involved in collapsing an already-fetched diff.
 *
 * Configurable via `VITE_RADR_DIFF_CONTEXT_LINES` — mirrors `focusConfig.ts`'s
 * `VITE_RADR_MAX_FOCUSED_CONVERSATIONS` pattern: Vite only ever inlines `import.meta.env` values
 * at build time, so it's read once here at module scope rather than re-read reactively.
 */
export const DEFAULT_DIFF_CONTEXT_LINES = 3;

/** Pure so it's directly unit-testable without touching `import.meta.env` — unset/empty/non-
 *  positive-integer all fall back to the default. */
export function resolveDiffContextLines(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_DIFF_CONTEXT_LINES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_DIFF_CONTEXT_LINES;
  return parsed;
}

/** Read once at module load (see doc comment above). */
export const diffContextLinesFromEnv = resolveDiffContextLines(
  import.meta.env.VITE_RADR_DIFF_CONTEXT_LINES,
);
