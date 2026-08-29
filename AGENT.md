# Agent Instructions

## Runtime (Node strip-types, no compile step in dev)

- Relative imports must include the explicit `.ts` extension.
- Don't guess CLI flags — use `--help`/docs

## Process management

- `npm run <script>` spawns child processes (`sh -c`, `node --watch`); killing only the reported PID
  leaves children running or respawning. Kill the whole process group/pattern in one pass, not an
  escalating `kill` → `pkill` → `pkill -9` sequence.

## Environment variables

`RADR_` prefix required for every app-defined var. Unprefixed only for third-party/platform vars
(`ANTHROPIC_API_KEY`, `NODE_ENV`).

## Testing

When a task includes tests: one pass/subagent authors the test from the spec's stated behavior only
(no implementation visibility), a separate pass implements to green. Test-writing stays optional per
task — this rule governs how tests are written when they exist, not whether they're required.

## Accessibility

Accessiblity requirments for the application is mandatory for light and dark mode support
