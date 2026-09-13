---

description: "Task list template for feature implementation"
---

# Tasks: SearXNG Web Search and Page Fetch for the Review Agent

**Input**: Design documents from `/specs/008-searxng-web-search/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/web-tools.md, quickstart.md

**Tests**: Included. `contracts/web-tools.md`'s "Contract test expectations" section enumerates
concrete test obligations for this feature, so test tasks are generated from it directly rather
than left optional.

**Organization**: Tasks are grouped by user story (US1, US2) to enable independent implementation
and testing. US1 and US2 are fully independent of each other — US1's tests run against a local HTTP
stub (no dependency on the devcontainer's real SearXNG instance), and US2 stands up SearXNG without
requiring any of US1's tool code to exist.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)
- Every task includes the exact file path(s) it touches

## Path Conventions

Existing monorepo layout (`plan.md` Project Structure): `app/backend/src/`, `app/backend/tests/`,
`app/shared/src/`, `.devcontainer/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Split the existing tool file into `pi/tools/` so both new tools land in the same
colocated module the plan calls for, without yet adding new tool behavior.

- [X] T001 [P] Add `html-to-text` as a dependency of `app/backend` (`npm install html-to-text --workspace=app/backend`), per research.md R3
- [X] T002 Move `createReadDocumentTool` and its helpers (including `renderReadResult`) out of `app/backend/src/pi/document-tools.ts` into new `app/backend/src/pi/tools/read-document.ts`, unchanged behavior
- [X] T003 Move `createProposeDocumentEditTool` out of `app/backend/src/pi/document-tools.ts` into new `app/backend/src/pi/tools/propose-document-edit.ts`, unchanged behavior, then delete `app/backend/src/pi/document-tools.ts` (depends on: T002)
- [X] T004 Create `app/backend/src/pi/tools/common.ts` with `textResult(text, details?)` and `clampWithNote(value, min, max, label)` helpers (research.md R7); update `read-document.ts` and `propose-document-edit.ts` to build their results via `textResult(...)` instead of inline `{content: [...], details}` object literals, and update `read-document.ts`'s clamp logic to use `clampWithNote(...)` (depends on: T002, T003)
- [X] T005 Create `app/backend/src/pi/tools/index.ts` barrel exporting `createReadDocumentTool` and `createProposeDocumentEditTool` (depends on: T002, T003, T004)
- [X] T006 Update the import in `app/backend/src/pi/pi-service.ts` (currently line 16) from `./document-tools.ts` to `./tools/index.ts` (depends on: T005)
- [X] T007 Run `npm run test:unit && npm run test:contract` and confirm all existing tests still pass unchanged, proving the split is behavior-preserving (depends on: T006)

**Checkpoint**: `pi/tools/` exists with the two existing tools moved in, behavior-identical. Ready for both `web_search`/`web_fetch` (US1) to be added alongside them.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Config and shared param schemas both new tools need before their implementations can be written.

**⚠️ CRITICAL**: Must complete before Phase 3 (US1) implementation tasks.

- [X] T008 [P] Add `webSearchParams` (`{ query: string, min length 1 }`) and `webFetchParams` (`{ url: string, min length 1 }`) Zod schemas to `app/shared/src/contracts/agent-tools.ts`, per data-model.md
- [X] T009 [P] Add `searxngUrl` to `Config` in `app/backend/src/config.ts`: read from `RADR_BE_SEARXNG_URL`, default `http://searxng:8080`, per research.md R6
- [X] T010 [P] Add a bounded, test-overridable timeout resolver to `app/backend/src/pi/tools/common.ts` (default e.g. 8000ms, overridable via `WEB_TOOL_TIMEOUT_MS`, mirroring `pi-service.ts`'s `resolveAgentTurnTimeoutMs` pattern), per research.md R4/R6 (depends on: T004)

**Checkpoint**: Config, shared schemas, and the shared timeout helper are in place — `web_search`/`web_fetch` implementations can now be written.

---

## Phase 3: User Story 1 - Agent grounds answers and proposals in current web information (Priority: P1) 🎯 MVP

**Goal**: The agent has `web_search` and `web_fetch` tools — read-only, registered like `read_document`, available regardless of branch/editing depth — so it can ground replies and edit proposals in current web information.

**Independent Test**: Call each tool object directly (`.execute(...)`) against a local HTTP stub standing in for SearXNG/a fetched page, and confirm both appear in `PiService.buildTools()`'s output for every conversation. No live SearXNG instance or devcontainer required (spec.md Independent Test / research.md R5).

### Tests for User Story 1

> Write these first; they exercise `contracts/web-tools.md`'s 10 contract test expectations against a local HTTP stub (Node's `http.createServer`), not a live backend.

- [X] T011 [P] [US1] Unit test: `web_search` against a stub returning N results returns exactly those N results (title/url/snippet each) in `app/backend/tests/unit/web-search-tool.test.ts`
- [X] T012 [P] [US1] Unit test: `web_search` against a stub returning zero results returns the plain "no results" text, not an error, in `app/backend/tests/unit/web-search-tool.test.ts`
- [X] T013 [P] [US1] Unit test: `web_search` against an unreachable/timing-out stub returns an explanatory error result and does not hang, in `app/backend/tests/unit/web-search-tool.test.ts`
- [X] T014 [P] [US1] Unit test: `web_search` with a blank/whitespace-only query returns an explanatory text result without calling the stub, in `app/backend/tests/unit/web-search-tool.test.ts`
- [X] T015 [P] [US1] Unit test: `web_fetch` against a stub HTML page returns extracted plain text, in `app/backend/tests/unit/web-fetch-tool.test.ts`
- [X] T016 [P] [US1] Unit test: `web_fetch` against a stub page larger than the size bound returns truncated text with a truncation note, in `app/backend/tests/unit/web-fetch-tool.test.ts`
- [X] T017 [P] [US1] Unit test: `web_fetch` against a stub returning a non-textual content type returns an explanatory error, not binary content, in `app/backend/tests/unit/web-fetch-tool.test.ts`
- [X] T018 [P] [US1] Unit test: `web_fetch` against an unreachable/timing-out stub returns an explanatory error result, in `app/backend/tests/unit/web-fetch-tool.test.ts`
- [X] T019 [US1] Contract test: `web_search` and `web_fetch` both appear in `PiService.buildTools(...)`'s output for a conversation at every `branchDepth` (including one beyond `maxEditingDepth`, where `propose_document_edit` is omitted but these two are not), in `app/backend/tests/contract/web-tools-registration.test.ts`
- [X] T020 [US1] Contract test: invoking either tool never creates a `staged_edit` row or emits `staged_edit_created`, asserted directly against the storage layer, in `app/backend/tests/contract/web-tools-registration.test.ts` (depends on: T019 — same file)

### Implementation for User Story 1

- [X] T021 [P] [US1] Implement `createWebSearchTool(deps)` in `app/backend/src/pi/tools/web-search.ts`: calls `${deps.searxngUrl}/search?q=<query>&format=json` with the bounded timeout (T010), caps results to a small fixed count (research.md R4), renders found/no-results/error/blank-query cases via `textResult` (T004), per contracts/web-tools.md (depends on: T004, T008, T009, T010)
- [X] T022 [P] [US1] Implement `createWebFetchTool(deps)` in `app/backend/src/pi/tools/web-fetch.ts`: fetches the given URL with the bounded timeout (T010), converts HTML responses to plain text via `html-to-text`, truncates via `clampWithNote` (T004, FR-012), and returns an explanatory error for non-textual/unreachable/failed responses, per contracts/web-tools.md (depends on: T001, T004, T008, T010)
- [X] T023 [US1] Extend `app/backend/src/pi/tools/index.ts` to also export `createWebSearchTool` and `createWebFetchTool` (depends on: T021, T022)
- [X] T024 [US1] Update `PiService.buildTools()` in `app/backend/src/pi/pi-service.ts` to construct and register both new tools unconditionally for every conversation (not gated by `maxEditingDepth`, unlike `propose_document_edit`), passing `config.searxngUrl` to `createWebSearchTool` (depends on: T023)
- [X] T025 [US1] Run T011-T020 and confirm they all pass against the real tool implementations (depends on: T021, T022, T023, T024)

**Checkpoint**: User Story 1 is fully functional and independently testable/demonstrable (via the stub-backed tests and `RADR_BE_PI_FAKE_SESSIONS`), even before US2's devcontainer/SearXNG service exists.

---

## Phase 4: User Story 2 - Developer has a working search backend with zero setup (Priority: P2)

**Goal**: The devcontainer runs a self-hosted SearXNG instance automatically, with JSON output enabled, reachable at `http://searxng:8080` — no manual step, account, or credential.

**Independent Test**: Rebuild the devcontainer fresh and confirm SearXNG is reachable with zero manual setup steps (spec.md Independent Test). Does not require any US1 tool code to exist.

### Implementation for User Story 2

- [X] T026 [P] [US2] Create `.devcontainer/searxng/settings.yml` setting `search.formats: [html, json]` (research.md R2)
- [X] T027 [P] [US2] Create `.devcontainer/docker-compose.yml` with an `app` service (building the existing `.devcontainer/Dockerfile`, preserving its current `build.args`/`mounts`/`containerEnv`/port mappings) and a `searxng` service (the official `searxng/searxng` image, mounting `.devcontainer/searxng/settings.yml`, setting a fixed dev-only `SEARXNG_SECRET_KEY`), both on one Compose network (research.md R1/R2)
- [X] T028 [US2] Convert `.devcontainer/devcontainer.json` from `build:` to `dockerComposeFile: ["docker-compose.yml"]` + `service: "app"` + `workspaceFolder`, preserving `postCreateCommand`, `remoteUser`, `customizations`, `forwardPorts`/`appPort` (depends on: T027)
- [ ] T029 [US2] Manually validate quickstart.md Scenario 1: rebuild the devcontainer and confirm `curl -s "http://searxng:8080/search?q=test&format=json"` returns a JSON body, not a 403 or connection error (depends on: T026, T027, T028) — **NOT run**: no Docker daemon is reachable from inside this sandboxed session (`docker`/`docker compose` are not on PATH here), so a devcontainer rebuild cannot be performed or validated from within this session. Needs a manual rebuild on a host with Docker.

**Checkpoint**: User Story 2 is independently verified. Combined with US1 (Phase 3), quickstart.md Scenarios 2-6 become runnable end-to-end.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final validation spanning both stories.

- [X] T030 [P] Document `RADR_BE_SEARXNG_URL` and the devcontainer's `searxng` service in `README.md`, alongside the existing `RADR_BE_*` configuration table
- [X] T031 Review every comment added or changed in this feature's diff for Constitution Principle VIII compliance (no historical/narrative comments; only durable, non-obvious gotchas)
- [~] T032 Run quickstart.md Scenarios 2-6 end-to-end (agent search/fetch grounding, backend-down resilience per FR-009/SC-004, fake-session inertness, stub-only default test suite) (depends on: T025, T029) — Scenarios 5 (fake-session inertness) and 6 (stub-only default suite) verified via the automated test suite (`npm run test:unit`/`test:contract`, no live SearXNG or internet, all green). Scenario 4 (backend-down resilience) is covered at the tool level by the unit tests' unreachable-stub cases (contract #3/#8: bounded explanatory error, no hang). Scenarios 2-3 (a live agent actually grounding a reply in `web_search`/`web_fetch` output) were **NOT run**: this sandboxed session has neither a Docker daemon (T029) nor a model provider credential (`ANTHROPIC_API_KEY`/`RADR_BE_PI_AGENT_MODEL` unset), so a live agent conversation cannot be started here. Needs manual validation on a host with both.
- [X] T033 Run `./scripts/verify.sh` and fix any failures until it exits green

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1 (T004's `common.ts` must exist for T010). Blocks Phase 3.
- **User Story 1 (Phase 3)**: Depends on Phase 2. Fully independent of User Story 2.
- **User Story 2 (Phase 4)**: Depends only on Phase 1 completing (no `document-tools.ts` dependency at all) — could in practice start as soon as the repo is checked out, but is ordered after Phase 3 here since it is P2. Fully independent of User Story 1.
- **Polish (Phase 5)**: Depends on both Phase 3 and Phase 4 (T032 exercises both stories together).

### User Story Dependencies

- **User Story 1 (P1)**: No dependency on User Story 2.
- **User Story 2 (P2)**: No dependency on User Story 1.

### Within Each User Story

- US1: tests (T011-T020) are written before the implementation tasks that make them pass (T021-T024), then re-run (T025).
- US2: settings + compose file (T026, T027, parallel) before the `devcontainer.json` conversion (T028), before manual validation (T029).

### Parallel Opportunities

- T001-T003 within Phase 1 are sequential (each depends on the file the previous step touches), but T001 (dependency install) can run in parallel with T002/T003.
- T008, T009, T010 (Phase 2) can all run in parallel — different files.
- T011-T018 (US1 tests) can all run in parallel — two independent test files.
- T021 and T022 (US1 implementation) can run in parallel — different files, both depend only on Phase 2.
- T026 and T027 (US2) can run in parallel — different files.
- Once Phase 2 completes, US1 (Phase 3) and US2 (Phase 4) can be staffed and run fully in parallel by different people, since neither depends on the other.

---

## Parallel Example: User Story 1

```bash
# Launch all US1 tests together:
Task: "Unit test: web_search N results in app/backend/tests/unit/web-search-tool.test.ts"
Task: "Unit test: web_search zero results in app/backend/tests/unit/web-search-tool.test.ts"
Task: "Unit test: web_fetch extracted text in app/backend/tests/unit/web-fetch-tool.test.ts"
Task: "Unit test: web_fetch truncation in app/backend/tests/unit/web-fetch-tool.test.ts"

# Then launch both tool implementations together:
Task: "Implement createWebSearchTool in app/backend/src/pi/tools/web-search.ts"
Task: "Implement createWebFetchTool in app/backend/src/pi/tools/web-fetch.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (Setup) and Phase 2 (Foundational).
2. Complete Phase 3 (User Story 1).
3. **STOP and VALIDATE**: run T011-T020/T025 — the agent's web-grounding capability is fully
   testable and demonstrable against the local stub and `RADR_BE_PI_FAKE_SESSIONS`, even without a
   real SearXNG instance anywhere. (An operator pointing `RADR_BE_SEARXNG_URL` at any reachable
   SearXNG-compatible instance — not necessarily the devcontainer's — makes it work live.)

### Incremental Delivery

1. Setup + Foundational → ready for either story.
2. Add User Story 1 → validate independently (MVP: the tool capability itself).
3. Add User Story 2 → validate independently (the devcontainer now provides its own SearXNG,
   removing the need for an externally-provided one during development).
4. Polish → documentation + full end-to-end validation of both together.

### Parallel Team Strategy

With two developers, once Phase 1+2 are done: one takes User Story 1 (Phase 3, backend tool code),
the other takes User Story 2 (Phase 4, devcontainer/compose) — neither blocks the other.
