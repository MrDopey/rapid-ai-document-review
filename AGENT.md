# Agent Instructions

## Runtime

Node strip-types, no compile step in dev. Relative imports need explicit `.ts` extension. Don't
guess CLI flags — check `--help`/docs.

## Process management

`npm run <script>` spawns child processes (`sh -c`, `node --watch`) — killing only the reported PID
leaves children running/respawning. Kill the whole process group/pattern in one pass, not an
escalating `kill` → `pkill` → `pkill -9` sequence.

## Environment variables

- `RADR_BE_` — backend-only
- `RADR_BE_TEST_` — backend test/tuning knobs, not application-facing config (e.g.
  `RADR_BE_TEST_FAKE_TURN_TIMEOUT_MS`/`RADR_BE_TEST_FAKE_CHUNK_DELAY_MS` in
  `app/backend/src/pi/fake-agent-session.ts`, `RADR_BE_TEST_AGENT_TURN_TIMEOUT_MS` in
  `app/backend/src/pi/pi-service.ts`, `RADR_BE_TEST_WEB_TOOL_TIMEOUT_MS` in
  `app/backend/src/pi/tools/common.ts`)
- `RADR_FE_` — frontend build/dev-server (read via `process.env`, e.g. `vite.config.ts`)
- `VITE_RADR_` — must be readable from browser code (`import.meta.env`); Vite only inlines
  `VITE_`-prefixed vars into the client bundle, so plain `RADR_FE_` is invisible there
- Unprefixed — third-party/platform only (`ANTHROPIC_API_KEY`, `NODE_ENV`). Full list in
  README's Configuration table.

## Testing

When tests are written for a task (optional per task): one pass authors the test from the spec's
behavior only, no implementation visibility; a separate pass implements to green.

Root `npm test` = backend only (`test:unit`/`test:integration`/`test:contract`,
`--workspace=app/backend`). Frontend suites run separately: `npm run test:unit --workspace=app/frontend`,
`npm run test:component --workspace=app/frontend`.

Ports: backend `3000`, frontend Vite `3001`. Single e2e story: `npm run test:e2e -- --grep "US<n>"`.

## Frontend UI verification

For layout/stacking/keyboard/focus changes, don't trust vitest/jsdom alone — it has missed real
bugs (focus-trap, z-index, hotkey dispatch). `claude-in-chrome` isn't available here; verify by
leaving the dev server running and giving the user precise repro steps.

## Frontend layout terminology

Canvas mode only (`App.vue`/`DocumentCanvas.vue`). Thread mode (`ThreadModeView.vue`, spec 011,
`.thread-mode-*`) is separate and non-interoperating — its own terms, not this diagram.
`.thread-columns` below is Canvas mode's sidebar, unrelated to "Thread mode."

Grep the class name before acting on layout/UI instructions — this app has layout-churn history:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ header.toolbar                                                           │
│  .document-title-bar : title ............ [shortcuts] [help]            │
│  .hud-bar-columns:  (shared, style.css — Thread mode's .thread-mode-hud  │
│                      below reuses this same ruleset, not a copy)        │
│    .hud-bar-left/.hud-box   → <HudPanel>  "HUD"    │ .hud-bar-right/    │
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

### Thread mode terms (`.thread-mode-*`, spec 011)

`ThreadModeView.vue` (`app/frontend/src/components/thread/`) is the whole view: a sticky
`.thread-mode-hud` bar (wraps the same shared `HudPanel` canvas mode uses, plus Expand-all/Export-
all/Done buttons, via the SAME `.hud-bar-columns`/`.hud-bar-left`/`.hud-bar-right` split Canvas
mode's own toolbar uses — see the Canvas-mode diagram above) above a scrolling `.thread-mode-content`
→ `.thread-mode-list` of `ThreadCard`s, both now left-aligned/full-width like Canvas's `.panes`
(no longer centered/content-sized).

```
┌──────────────────────────────────────────────────────────────────────────┐
│ .thread-mode-view                                                        │
│  ┌─ .thread-mode-hud (sticky, full-width painted bar) ─────────────────┐  │
│  │  .hud-bar-columns:                                                  │  │
│  │    .hud-bar-left/.hud-box → <HudPanel> "Threads" │ .hud-bar-right/  │  │
│  │                                                   │ .actions-group: │  │
│  │                                                   │  [Expand-all]   │  │
│  │                                                   │  [Export-all]   │  │
│  │                                                   │  [Done (n)]     │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  ┌─ .thread-mode-content ────────────────────────────────────────────┐  │
│  │  .thread-mode-list:                                               │  │
│  │   ┌─ <ThreadCard> (top-level thread) ───────────────────────────┐ │  │
│  │   │  .thread-card-header : title/rename ......... [actions]     │ │  │
│  │   │  [.error-banner]  (only when thread.status === 'errored')    │ │  │
│  │   │  .thread-run-chain: [.thread-card] [.thread-card] ...        │ │  │
│  │   │        ┆ .thread-branch-row → nested <ThreadCard> (branch)   │ │  │
│  │   │  <ThreadComposer>  (open end of thread/branch)                │ │  │
│  │   └────────────────────────────────────────────────────────────┘ │  │
│  │   ┌─ <ThreadCard> (next top-level thread) ─────────────────────┐  │  │
│  │   │  ...                                                       │  │  │
│  │   └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  ░░ [doneOpen] → .modal-overlay.done-threads-overlay → <DoneThreadsPanel> │
└──────────────────────────────────────────────────────────────────────────┘
```

- **thread card** = `ThreadCard.vue`'s `.thread-card-header` (title/rename/actions) plus its
  `.thread-run-chain` — the chain of message-run boxes (also class `.thread-card`) below it.
- **branch** = a nested `ThreadCard` reachable via `.thread-branch-row`, forked off a parent run.
- **composer** = `ThreadComposer.vue`, the send box at a thread/branch's open end.
- **Done panel** = `DoneThreadsPanel.vue`, opened via the HUD's Done button into a
  `.done-threads-overlay`.
