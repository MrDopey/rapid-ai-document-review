# Implementation Plan: Todo & Parking Lot Lists

**Branch**: `012-todo-parking-lists` | **Date**: 2026-09-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-todo-parking-lists/spec.md`

## Summary

Add two simple, document-scoped string-item lists ("Todo" and "Parking Lot") that the agent can
manage via four new tool calls (add/update/remove, each hash-gated against stale writes, plus a
read-only `list_items`) and the user can manage via ordinary HTTP CRUD from a shared frontend
panel. The panel is toggled from a new `.hud-bar-right` control, mounted differently per view mode:
in Canvas mode it's a single shared rail attached to the focused-conversation overlay (disabled
until a conversation is focused); in Thread mode it's a fixed rail hugging the right edge of the
viewport, always enabled, narrowing (not covering) the thread list. Both the agent's tool-call path
and the user's HTTP path funnel through one `ListItemService`, so changes from either source reach
every open client live via the existing document-wide WebSocket event stream.

## Technical Context

**Language/Version**: TypeScript (Node ≥26.1.0, `node --experimental-strip-types`, no compile step
in dev per `AGENTS.md`); Vue 3.5 (frontend).

**Primary Dependencies**: `@earendil-works/pi-coding-agent` (Pi SDK, tool registration), `zod`
(shared contract schemas), `typebox` (tool parameter schemas), `node:sqlite` (storage), `node:crypto`
(short hash — no new dependency), Pinia (frontend store), `@vue/test-utils`/`vitest`.

**Storage**: SQLite via the existing `StorageAdapter` abstraction (`app/backend/src/storage/`);
one new table, `list_item` (data-model.md).

**Testing**: `vitest` — backend `tests/unit`, `tests/integration`, `tests/contract`
(`npm run test:unit|test:integration|test:contract --workspace=app/backend`); frontend
`tests/unit`, `tests/component` (`npm run test:unit|test:component --workspace=app/frontend`).
Single e2e story via Playwright: `npm run test:e2e -- --grep "US<n>"` if an E2E story is added for
this feature (frontend UI verification also requires manual browser verification per `AGENTS.md`
for the rail's layout/reflow behavior — vitest/jsdom does not catch real layout bugs).

**Target Platform**: Self-hosted Docker, localhost-bound backend (Linux server); modern desktop
browser (frontend).

**Project Type**: Web application (existing `app/backend` + `app/frontend` + `app/shared`
workspaces) — Option 2 in the structure below.

**Performance Goals**: No new performance target beyond the existing app's interactive-latency
norms (SC-002/SC-003: sub-second live update, sub-10s manual CRUD); list sizes are expected to stay
small (a human-curated todo/parking-lot list, not a bulk data table), so no pagination is designed.

**Constraints**: No enforced maximum item count or text length beyond ordinary reasonable limits
(spec.md Assumptions); the stale-write hash is explicitly not a security control (research.md R2).

**Scale/Scope**: Single local user/account (existing constraint), one document at a time; two
lists per document, each expected to hold at most a handful to a few dozen items.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. The Application Owns the Document | PASS | List items are new application-owned state, not a competing source of truth for document content. |
| II. Pi Owns Agent Conversations | PASS | New tools registered via the Pi SDK's `customTools` only (`defineTool`); no reading/writing of Pi's session storage format. |
| III. Agent Edits Are Proposals, Not Direct Writes | PASS (scope note) | This principle governs *document* content mutation specifically. List items are a separate sidecar entity the agent's new tools mutate directly (like renaming a conversation) — never through the staged-edit pipeline, and never touching Automerge document state. |
| IV. CRDT-Mediated Merging | N/A | List items are not document content; Automerge governs document state only. Conflict handling here is the simpler hash-based optimistic-concurrency check specified in FR-008 (research.md R2), which is sufficient for a single-scalar-field row. |
| V. Configurable Limits Are Enforced | N/A | No new configurable limit is introduced by this feature. |
| VI. Sanitize Before Render | PASS (implementation gate) | List item text is plain text only (spec.md Assumptions) and MUST be rendered as plain text in the panel (text interpolation, never `v-html`/innerHTML) — it does not go through the Markdown/Mermaid/SVG rendering pipeline this principle's sanitizer abstraction targets, so no change to that abstraction is needed, but the plain-text-only rendering requirement is carried into tasks.md as an explicit implementation constraint. |
| VII. No Pi Extension Without Demonstrated Necessity | PASS | All four new tools use the existing `customTools` mechanism; no Pi extension. |
| VIII. Comments Are Durable, Not Historical | PASS (review-time gate) | Applies at code-review time during implementation, not planning. |

**Technology & Platform Constraints — PASS (amended)**:

The constraints originally listed "additional agent tools beyond document
read/edit/web-search/web-fetch" as an explicit v1 non-goal, which would have excluded
FR-003/FR-004/FR-005/FR-010's four new tools (`add_list_item`/`update_list_item`/`remove_list_item`/
`list_items`). This was resolved the same way the project resolved the analogous `web_search`/
`web_fetch` situation: a scoped constitution amendment, not a per-plan waiver (research.md R4).
`.specify/memory/constitution.md` was amended to v2.6.0 (carving out add/remove/update) and then
v2.7.0 (extending the carve-out to the read-only `list_items` tool, once that tool's necessity
became clear during Phase 1 design). Both amendments are committed. The tool contracts in
`contracts/agent-tools-list-items.md` satisfy the amendment's stated conditions (ordinary
`customTools`, no Pi extension, no document-content mutation) as designed, with no further changes
needed.

*Re-checked after Phase 1 design: no new violations introduced by data-model.md/contracts/
quickstart.md; the one violation identified during Phase 0 is resolved by the v2.6.0/v2.7.0
amendments above.*

## Project Structure

### Documentation (this feature)

```text
specs/012-todo-parking-lists/
├── plan.md                          # This file
├── research.md                      # Phase 0 output
├── data-model.md                    # Phase 1 output
├── quickstart.md                    # Phase 1 output
├── contracts/
│   ├── agent-tools-list-items.md    # Phase 1 output — 4 new Pi tool calls
│   └── list-items-http-api.md       # Phase 1 output — REST + WS events for User Story 4
└── tasks.md                         # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
app/backend/
├── src/
│   ├── storage/
│   │   ├── storage-adapter.ts        # + ListItemRow, 5 new methods (data-model.md)
│   │   └── sqlite/
│   │       ├── migrations.ts         # + list_item CREATE TABLE + migration version bump
│   │       └── index.ts              # + SqliteStorageAdapter method impls
│   ├── list-items/                   # NEW module (mirrors edit/, events/ sibling modules)
│   │   ├── content-hash.ts           # computeContentHash(text): string (research.md R2)
│   │   └── list-item-service.ts      # ListItemService — shared by tool-call path + HTTP path
│   ├── pi/
│   │   ├── tools/
│   │   │   ├── list-items.ts         # NEW — 4 defineTool() factories
│   │   │   └── index.ts              # + export the 4 new factories
│   │   └── pi-service.ts             # + register the 4 tools in the customTools array
│   └── api/http/
│       └── list-items.ts             # NEW — GET/POST/PATCH/DELETE routes (list-items-http-api.md)
└── tests/
    ├── unit/list-item-service.test.ts       # NEW
    ├── unit/content-hash.test.ts            # NEW
    ├── contract/http.test.ts                # + new endpoint cases
    └── integration/ (existing suite)        # + agent tool-call scenarios (fake-agent-session)

app/shared/src/contracts/
├── http.ts        # + ListItemDto, request/response schemas
├── events.ts       # + list_item_added/updated/removed
└── agent-tools.ts  # + Zod mirrors of the 4 tool params (TypeBox mirrors live alongside tools)

app/frontend/
├── src/
│   ├── stores/
│   │   └── listItems.ts              # NEW — Pinia store, WS event handling
│   ├── components/
│   │   ├── TodoParkingListsPanel.vue # NEW — shared rail content (.todo-list-section / .parking-lot-section)
│   │   └── thread/ThreadModeView.vue # + Lists button, rail mount, flex reflow layout
│   └── App.vue                       # + Lists button (disabled-until-focused), rail mount inside .conversation-detail-overlay
└── tests/
    ├── unit/listItems.store.spec.ts        # NEW
    └── component/todoParkingListsPanel.spec.ts  # NEW
```

**Structure Decision**: Existing web-application layout (`app/backend` + `app/frontend` +
`app/shared` npm workspaces) is reused as-is; this feature adds one new backend module
(`list-items/`), one new tool file, one new HTTP route file, one new frontend store, and one new
shared frontend component mounted from two existing call sites (`App.vue`, `ThreadModeView.vue`) —
no new top-level project or workspace.

## Complexity Tracking

> Constitution Check has no unresolved violations. The one gate that initially failed (Technology &
> Platform Constraints, new agent tools) was resolved by amending `.specify/memory/constitution.md`
> to v2.6.0 and v2.7.0 (research.md R4) rather than by a plan-level waiver — no complexity-tracking
> entry is needed.
