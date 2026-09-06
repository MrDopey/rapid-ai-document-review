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

## Frontend UI verification

For layout/stacking/keyboard/focus changes: don't rely on vitest/jsdom alone — it has repeatedly
missed real bugs (focus-trap, z-index, hotkey dispatch) that only manual browser use caught.
`claude-in-chrome` is not available in this environment, so verify by leaving the dev server
running and reporting precise repro steps for the user to check manually.

## Frontend layout terminology

Disambiguate these terms before acting on layout/UI instructions — grep the class name first, this
app has active layout-churn history (numbered feature specs have reshuffled it before):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ header.toolbar                                                           │
│  .document-title-bar : title ............ [shortcuts] [help]            │
│  .toolbar-columns:                                                      │
│    .toolbar-left/.hud-box   → <HudPanel>  "HUD"    │ .toolbar-right/    │
│                                                     │ .actions-group    │
│  [.toolbar-conflict-banner]  (only when a conflict message is set)      │
├──────────────────────────────────────────────────────────────────────────┤
│ .panes   (grid: Preview | handle | Canvas | [History])                  │
│  ┌────────────┐ ┆ ┌───────────────────────┐  ┌─ .history-drawer ─────┐  │
│  │<Preview    │ ┆ │   <DocumentCanvas>    │  │  <HistoryPanel>       │  │
│  │Component>  │ ┆ │   (editor + sidebar)  │  │  (v-if historyOpen)   │  │
│  └────────────┘ ┆ └───────────────────────┘  └───────────────────────┘  │
│                                                                          │
│  ░░ .conversation-detail-overlay ░░  ← absolutely positioned over just  │
│  ░░ the Canvas grid column; 1..N <ConversationDetailPanel> instances ░░ │
└──────────────────────────────────────────────────────────────────────────┘
```

- **HUD** — compact conversation list rows (title/badges), click toggles focus. Not the
  conversation content.
- **sidebar** = `.thread-columns` inside `DocumentCanvas.vue`, next to the editor. One
  `.thread-column` → `ConversationThreadBox` per conversation, anchored to its spot in the document.
- **conversation overlay / detail overlay** — the expanded/focused full view, distinct from both
  HUD and sidebar.
- **History panel** = `HistoryPanel.vue`, toggled by `historyOpen`.
