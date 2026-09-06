/**
 * Shared `import.meta.env` int-parsing boilerplate for `VITE_`-prefixed numeric config vars —
 * `focusConfig.ts`'s `resolveMaxFocusedConversations` and `diffContextConfig.ts`'s
 * `resolveDiffContextLines` were near-identical: unset/empty falls back to the default, otherwise
 * `Number(raw)` must be a finite integer no smaller than `opts.min` or it also falls back.
 *
 * Pure so it's directly unit-testable without touching `import.meta.env`.
 */
export function resolveEnvInt(
  raw: string | undefined,
  defaultValue: number,
  opts: { min: number },
): number {
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < opts.min) return defaultValue;
  return parsed;
}
