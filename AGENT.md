# Agent Instructions

## Runtime (Node strip-types, no compile step in dev)

- Relative imports must include the explicit `.ts` extension.
- Don't guess CLI flags — use `--help`/docs

## Process management

- `npm run <script>` spawns child processes (`sh -c`, `node --watch`); killing only the reported PID
  leaves children running or respawning. Kill the whole process group/pattern in one pass, not an
  escalating `kill` → `pkill` → `pkill -9` sequence.

## Environment variables

Backend-only vars use the `RADR_BE_` prefix; frontend build/dev-server vars (read via
`process.env`, e.g. in `vite.config.ts`) use `RADR_FE_`; vars that must also be readable from
browser code (via `import.meta.env`) use `VITE_RADR_` — Vite only ever inlines `import.meta.env`
values prefixed `VITE_` into the client bundle, so a plain `RADR_FE_` var is invisible there.
Unprefixed only for third-party/platform vars (`ANTHROPIC_API_KEY`, `NODE_ENV`). Known pre-existing
unprefixed exceptions: `PI_FAKE_TURN_TIMEOUT_MS`/`PI_FAKE_CHUNK_DELAY_MS`
(`app/backend/src/pi/fake-agent-session.ts`), `PI_AGENT_TURN_TIMEOUT_MS`
(`app/backend/src/pi/pi-service.ts`), and `WEB_TOOL_TIMEOUT_MS` (`app/backend/src/pi/tools/common.ts`)
— these are grandfathered, not license to add more unprefixed vars. See README.md's Configuration
table for the full authoritative list.

## Testing

When a task includes tests: one pass/subagent authors the test from the spec's stated behavior only
(no implementation visibility), a separate pass implements to green. Test-writing stays optional per
task — this rule governs how tests are written when they exist, not whether they're required.

Root `npm test` only runs backend tests (`test:unit`/`test:integration`/`test:contract`, all
`--workspace=app/backend`) — it does not run the frontend's vitest suites. Run those explicitly:
`npm run test:unit --workspace=app/frontend` and `npm run test:component --workspace=app/frontend`.

Dev-server ports: backend `3000`, frontend Vite dev server `3001` (`app/frontend/vite.config.ts`).
Run a single e2e story with `npm run test:e2e -- --grep "US<n>"`.

## Frontend UI verification

For layout/stacking/keyboard/focus changes: don't rely on vitest/jsdom alone — it has repeatedly
missed real bugs (focus-trap, z-index, hotkey dispatch) that only manual browser use caught.
`claude-in-chrome` is not available in this environment, so verify by leaving the dev server
running and reporting precise repro steps for the user to check manually.

## Frontend layout terminology

Covers Canvas mode only (`App.vue`/`DocumentCanvas.vue`). Thread mode (`ThreadModeView.vue`, spec
011, class namespace `.thread-mode-*`) is a separate, non-interoperating view with its own terms —
`.thread-columns` below is Canvas mode's sidebar and is NOT the same thing as "Thread mode."

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
