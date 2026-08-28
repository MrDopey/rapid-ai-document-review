# Tasks: AI Document Review Application

**Input**: Design documents from `/specs/001-ai-document-review/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [research.md](./research.md), [quickstart.md](./quickstart.md)

**Organization**: Tasks are grouped by user story (US1–US7, from spec.md priorities P1→P4) to enable independent implementation and testing of each story. Each phase is a complete, independently testable increment.

**Path conventions**: `packages/backend/src/`, `packages/frontend/src/`, `packages/shared/src/`, `tests/e2e/`

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: User story label (US1–US7)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo scaffolding, tooling, and Docker — no feature logic yet.

- [X] T001 Initialise npm workspaces root with `package.json`, `tsconfig.base.json`, `.nvmrc` (Node 26.1.0), and workspace entries for `packages/backend`, `packages/frontend`, `packages/shared`
- [X] T002 [P] Scaffold `packages/shared` with `package.json`, `tsconfig.json` referencing base, and `src/contracts/` + `src/domain/` empty directories
- [X] T002b [P] Scaffold `packages/backend` with `package.json` (Fastify, Automerge, pino, Zod, Pi SDK, Vitest, Playwright deps), `tsconfig.json`, and `src/` directory tree matching plan.md structure
- [X] T003 [P] Scaffold `packages/frontend` with Vite + Vue 3 + TypeScript setup via `npm create vite`, adding CodeMirror 6, markdown-it, DOMPurify, mermaid, diff, Pinia to `packages/frontend/package.json`
- [X] T004 [P] Write `docker/Dockerfile` (node:26.1.0-trixie, multi-stage: build frontend → compile backend → runtime image) and `docker/docker-compose.yml` (single service, volumes for `DATABASE_PATH` and `PI_SESSION_STORAGE_PATH`)
- [X] T005 [P] Configure ESLint + Prettier across all packages via root `eslint.config.mjs` and `.prettierrc`

**Checkpoint**: `npm install` succeeds; `npm run dev` placeholder scripts exist.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that ALL user story phases depend on. No user story work until this phase is complete.

**⚠️ CRITICAL**: No user story implementation can begin until this phase completes.

### Shared contracts and domain types

- [X] T006 [P] Define shared domain types in `packages/shared/src/domain/index.ts`: `Document`, `Revision`, `Conversation`, `StagedEdit`, `UserSettings`, `ConflictDetail` (operation-level `{ index, reason, occurrences }`) — plain TypeScript interfaces, no Zod yet
- [X] T007 [P] Define HTTP request/response Zod schemas in `packages/shared/src/contracts/http.ts` for every endpoint in `contracts/http-api.md` (document CRUD, revisions, conversations, edits, settings); export inferred TypeScript types
- [X] T008 [P] Define WebSocket event Zod discriminated union in `packages/shared/src/contracts/events.ts` covering all `type` values in `contracts/websocket-events.md`; mark ephemeral events; export inferred types
- [X] T009 [P] Define agent tool Zod schemas in `packages/shared/src/contracts/agent-tools.ts`: `readDocumentParams`, `proposeDocumentEditParams` (with `operations` array capped `minItems: 1, maxItems: 50`, `summary`); export inferred types

### Backend infrastructure

- [X] T010 [P] Implement `packages/backend/src/logging.ts`: create a pino instance with JSON output, structured `event` field using the event vocabulary from `contracts/websocket-events.md` (FR-042)
- [X] T011 [P] Implement `packages/backend/src/config.ts`: read `PORT`, `HOST` (assert `127.0.0.1`), `DATABASE_PATH`, `PI_SESSION_STORAGE_PATH`, `PI_CODING_AGENT_DIR`, `LOG_LEVEL` from env; export a typed `Config` object; do NOT expose configurable limits here (those come from `user_settings`)
- [X] T012 Define `packages/backend/src/storage/storage-adapter.ts`: `StorageAdapter` interface with repository methods for all eight tables from `data-model.md` (document, revision, document_snapshot, document_change, conversation, staged_edit, conversation_event, user_settings)
- [X] T013 Implement `packages/backend/src/storage/sqlite/migrations.ts`: create all eight tables with constraints exactly as in `data-model.md`; apply via `npm run db:migrate`; implement `packages/backend/src/storage/sqlite/index.ts` as the `StorageAdapter` SQLite implementation using `node:sqlite`
- [X] T014 [P] Implement `packages/backend/src/document/automerge-store.ts`: load (snapshot + incremental changes), save incremental change, periodic snapshot, expose `splice(from, to, insert)` and `getContent()`, and `view(heads)` for past-revision export
- [X] T015 [P] Implement `packages/backend/src/document/text-anchor.ts`: anchored reconciliation algorithm from research R4 — given `operations: {old_string, new_string}[]` and current document text, return `{outcome: 'clean', patches}` or `{outcome: 'conflict', detail: ConflictDetail[]}` per `data-model.md §6` rules (exactly-once, no-overlap)
- [X] T016 Implement `packages/backend/tests/unit/text-anchor.test.ts`: unit tests for `text-anchor.ts` covering all four conflict reasons (`not_found`, `ambiguous`, `overlapping`, clean) and multi-operation atomicity; run with `npm run test:unit`
- [X] T017 [P] Implement `packages/backend/tests/fakes/fake-pi-session.ts`: `FakePiSession` test double implementing the Pi SDK's `AgentSession` interface; supports scripted event emission (`text_delta`, `message_completed`, `tool_execution_end`), configurable tool-call ids, and error injection; no real Pi SDK calls
- [X] T018 Implement `packages/backend/src/events/event-service.ts`: append `conversation_event` rows with monotonic per-document sequence; `getEventsSince(documentId, sequence)` for replay; `getLatestSequence(documentId)`
- [X] T019 Implement `packages/backend/src/events/run-buffer.ts`: per-active-run in-memory buffer for partial response text; `append(runId, delta)`, `getBuffer(runId)` for mid-run reconnect replay (FR-037a); cleared on `agent_completed`
- [X] T020 Implement `packages/backend/src/events/event-hub.ts`: WebSocket fan-out; subscribe socket with `sinceSequence`; on subscribe: send persisted frames since sequence + current snapshot, then live frames; backpressure is defined as the socket's `bufferedAmount` exceeding 1MB — while above that threshold, drop only ephemeral frame types (`text_delta`, `thinking_delta`, `tool_output_delta`) until the buffer drains back below it; persisted frames are never dropped (websocket-events.md §Ordering guarantee 6)

**Checkpoint**: Schema migrations apply; text-anchor unit tests pass; FakePiSession compiles.

---

## Phase 3: User Story 1 — Create and edit a document with tracked history (P1) 🎯 MVP

**Goal**: A Markdown editor backed by Automerge CRDT with debounced revision history, restore, and export. No agent activity.

**Independent Test**: `npm run test:e2e -- --grep "US1"` — paste document, edit, wait for debounce, restore earlier revision, export, render/sanitize Mermaid and SVG, confirm XSS payload stripped.

### Backend — US1

- [X] T021 [US1] Implement `packages/backend/src/document/document-service.ts`: `create(title, content)` — default `title` server-side to the first level-1 Markdown heading in `content`, else `"Untitled"`, when omitted (FR-001a); initialise Automerge doc, persist snapshot, create `revision 1` (`origin: 'creation'`), create Main conversation row, emit `document_created` + `revision_created`; `get()` — return document + live content + latest event sequence; `applyChanges(baseRevision, changes)` — replay CodeMirror change specs as Automerge splices, persist incremental change, compute SHA-256 of the full post-change content as `contentHash`, broadcast `document_content_changed` with `contentHash` in its payload (websocket-events.md §document_content_changed); log a `warn` (no write rejection) when `currentRevision - baseRevision > 50`, indicating a badly out-of-sync client; `renameTitle(title)` — update `document.title` only, no revision created (FR-001a)
- [X] T022 [US1] Implement `packages/backend/src/document/revision-service.ts`: debounce timer (`revision_debounce_ms` from user_settings) — schedule revision after inactivity, cancel on new change; `createRevision(origin, source, opts)` — insert `revision` row, update `document.current_revision`, take Automerge snapshot if threshold met, emit `revision_created`; `restore(revisionNumber)` — load `heads` from revision, apply as new Automerge change, create new revision with `origin: 'restore'`, emit `revision_created` + `revision_restored`; `export(revisionNumber?)` — return Markdown text from `Automerge.view(doc, heads)` or current content
- [X] T023 [US1] Implement `packages/backend/src/api/http/document.ts`: route handlers for `POST /api/document`, `GET /api/document`, `PATCH /api/document` (accepts an optional `title` field alongside `baseRevision`/`changes` to call `DocumentService.renameTitle`, FR-001a — note: not yet spelled out as a separate field in `contracts/http-api.md`'s PATCH request example; flag for a future contract-doc pass), `GET /api/document/export` (`404 DOCUMENT_NOT_FOUND` before creation and when `?revision=` doesn't exist) validated against shared Zod schemas from `packages/shared/src/contracts/http.ts`; include `eventSequence` in `GET /api/document` response
- [X] T024 [US1] Implement `packages/backend/src/api/http/revisions.ts`: route handlers for `GET /api/revisions` (cursor-paginated: `?cursor=<opaque>&limit=<1-100, default 50>`, newest-first, returns top-level `nextCursor: string | null`) and `POST /api/revisions/:revision/restore`
- [X] T025 [US1] Implement `packages/backend/src/api/ws/index.ts`: WebSocket upgrade at `GET /events`; parse `subscribe` frame, validate `sinceSequence`, call `EventHub.subscribe(socket, sinceSequence)`; handle `ping` → `pong`; disconnect without marking any agent failed (FR-037)
- [X] T026 [US1] Implement `packages/backend/src/server.ts`: Fastify bootstrap; bind to `127.0.0.1:PORT` only (FR-044); register `@fastify/websocket`; mount all HTTP route modules; on startup run `StorageAdapter.getDocument()` — if found, load Automerge state from snapshots + changes and restore `EventHub`

### Frontend — US1

- [X] T027 [US1] Implement `packages/frontend/src/render/markdown-pipeline.ts`: markdown-it instance with Mermaid fence renderer and SVG pass-through; `render(markdown) → dirtyHtml`; `packages/frontend/src/render/sanitizer.ts`: DOMPurify `SanitizerPort.sanitize(html) → safeHtml` configured as an allowlist (FR-008b) — permit standard Markdown elements (headings, lists, tables, links, `http(s)` images, code blocks, blockquotes) plus sanitized inline SVG and Mermaid-rendered SVG; always strip `<script>`, inline event-handler attributes, `javascript:`/non-image `data:` URIs, iframes, forms, and embed/object elements; apply after every render step including agent reasoning (FR-008, FR-008a, Principle VI)
- [X] T028 [P] [US1] Implement `packages/frontend/src/render/extensions/mermaid.ts`: Mermaid code fence → SVG render via `mermaid.render()`; pipe SVG through sanitizer; on render failure (malformed diagram, invalid vector graphic, non-completing render, or exceeding a configured complexity ceiling) replace only that region with a visible inline notice plus the raw source in a fallback code block — never blank the region or interrupt rendering of the rest of the document (FR-008c); `packages/frontend/src/render/extensions/svg.ts`: pass-through for inline `<svg>` blocks, sanitized, with the same render-failure fallback behavior
- [X] T029 [US1] Implement `packages/frontend/src/stores/document.ts` (Pinia): state for `document`, `content`, `revisions`, `eventSequence`; actions `create`, `patchContent`, `loadRevisions`, `restore`, `exportRevision`; `packages/frontend/src/transport/http-client.ts`: typed Fastify client using shared Zod schemas
- [X] T030 [US1] Implement `packages/frontend/src/transport/ws-client.ts`: WebSocket connection to `ws://127.0.0.1:PORT/events`; on connect send `{ type: 'subscribe', sinceSequence }` from stored `eventSequence`; handle reconnect with replay; dispatch received events to Pinia stores; heartbeat `ping/pong` every 15 s; expose a `reconnecting: boolean` state that is `true` from disconnect-detected until the caught-up subscribe handshake completes (FR-037b); on `document_content_changed`, compare its `contentHash` (SHA-256, websocket-events.md §document_content_changed) against a hash of the store's own current content and call `DocumentService.get()` to refetch on any mismatch rather than attempting to diagnose the divergence
- [X] T030a [US1] Implement a non-blocking "reconnecting" indicator (e.g. in `packages/frontend/src/components/hud/` or `App.vue`) bound to `wsClient.reconnecting`: visible without clearing or blanking previously loaded content while `true`, cleared once the caught-up state is applied (FR-037b)
- [X] T031 [US1] Implement `packages/frontend/src/App.vue`: mount paste screen when `GET /api/document` returns 404; switch to editor layout once document exists; `packages/frontend/src/main.ts`: mount Pinia + App
- [X] T032 [US1] Implement `packages/frontend/src/components/editor/`: CodeMirror 6 host (`EditorComponent.vue`) with `@codemirror/lang-markdown`, `@codemirror/commands` (undo/redo FR-007); debounce `PATCH /api/document` calls on change; emit selection range for branch action
- [X] T033 [US1] Implement `packages/frontend/src/components/preview/`: rendered Markdown pane (`PreviewComponent.vue`) — calls `render()` + `sanitize()` on `document.content`; updates on `document_content_changed` event
- [X] T034 [US1] Implement `packages/frontend/src/components/history/`: `HistoryPanel.vue` — revision list showing `revision`, `source`, `origin`, `conversationName`, `note`, `createdAt`; restore button triggers `POST /api/revisions/:revision/restore`; export button downloads or copies Markdown via `GET /api/document/export?revision=N&download=1`
- [X] T035 [US1] Write `tests/e2e/us1.spec.ts`: Playwright spec covering all seven US1 quickstart scenarios — paste, edit+sync (two tabs), debounce, restore, undo/redo, export, sanitizer (XSS payload absent from DOM)

**Checkpoint**: US1 fully functional and tested independently. No agent, no conversations shown yet except the Main placeholder.

---

## Phase 4: User Story 2 — Ask the main conversation about the document (P1)

**Goal**: Stream answers to user questions from Main (always-present, always Primary at creation). No edit proposals yet.

**Independent Test**: `npm run test:e2e -- --grep "US2"` — send message to Main, verify streamed response grounded in document content; toggle reasoning visibility.

### Backend — US2

- [X] T036 [US2] Implement `packages/backend/src/pi/system-prompt.ts`: compose system prompt per `contracts/agent-tools.md §System prompt contract` — role, tool discipline (`read_document` before proposing), anchor discipline, proposal etiquette, review authority, branch context; load via `DefaultResourceLoader`; the six numbered obligations are the versioned, contractual part of the prompt (agent-tools.md) — changing their wording is a contract amendment, while surrounding phrasing is free-form implementation detail
- [X] T037 [US2] Implement `packages/backend/src/pi/document-tools.ts` — `read_document` tool only: `defineTool({ name: 'read_document', parameters: readDocumentParams, execute: async (toolCallId, { from_line, to_line }) => ... })` — serve from conversation's `context_revision`, include line-numbered header; depth check: reading is NOT gated by `max_editing_depth` (FR-026); invalid parameters handled without throwing — `from_line > to_line` returns an explanatory text result instead of content, and a line number beyond the document's length is clamped with an explanatory note (e.g. "requested to line 500, clamped to 240") rather than erroring
- [X] T038 [US2] Implement `packages/backend/src/pi/event-bridge.ts`: translate Pi `AgentSessionEvent` → application events per `contracts/agent-tools.md §Event bridge contract` mapping table; emit `text_delta`/`thinking_delta` to `RunBuffer` + `EventHub` (ephemeral, not persisted); persist all non-ephemeral events via `EventService`; suppress `thinking_delta` when `user_settings.thinking_visible = false`; a Pi event arriving for a run whose `agent_completed`/`agent_settled` frame has already been emitted (e.g. a delayed `tool_execution_end`), or for an `AgentSession` the application no longer considers active (e.g. after a restart where in-flight sessions were marked errored per FR-039a), MUST be logged at `warn` and discarded, never translated into an application event or re-attached to the closed run
- [X] T039 [US2] Implement `packages/backend/src/pi/pi-service.ts`: the ONLY module importing `@earendil-works/pi-coding-agent`; `createSession(conversation, tools)` — `createAgentSession({ noTools: 'all', customTools, sessionManager, resourceLoader, modelRuntime })`; `send(sessionId, message)` — `session.prompt()`; subscribe to Pi events and pipe through `EventBridge`; `SessionManager.open(path)` for closed-conversation reads
- [X] T040 [US2] Implement `packages/backend/src/conversation/concurrency-limiter.ts`: track conversations with an in-flight run; the limit counts only conversations with an actively running turn — a queued prompt does not count while waiting, and no conversation (including Primary and review) is exempt (FR-015a); `acquire(conversationId)` — if `running < max_concurrent_agents`, start immediately and emit `agent_started`; else capture the document context revision at submission time (used later regardless of when the prompt is actually dequeued, per FR-015a/FR-017) and queue FIFO, emitting `agent_queued` with `{ queuePosition, runningCount, limit }`; re-emit `agent_queued` with the updated `queuePosition` whenever an earlier-queued prompt is dequeued ahead of it, without waiting for it to start (FR-015a); prompts cannot be cancelled once submitted in v1; `release(conversationId)` — emit `agent_dequeued` and start next in queue
- [X] T041 [US2] Implement `packages/backend/src/conversation/conversation-service.ts`: `ensureMain(documentId)` — idempotent Main creation; `send(conversationId, message)` — guard against closed status, call `ConcurrencyLimiter.acquire`, call `PiService.send`, on Pi error set `status: 'errored'`; `retry(conversationId)` — re-send the same failed turn (existing message history preserved, nothing restarted from scratch); relies on FR-040 idempotency if a tool call had already run before the failure (FR-038); `getAll(documentId)` — return cursor-paginated list (`?cursor=<opaque>&limit=<1-100, default 50>`, ordered by `createdAt` ascending, `nextCursor: string | null`) with computed `isStale`, `canEdit`, `canBranch`, `pendingEditCount` (excludes `superseded` proposals — they no longer await a verdict, FR-032c); `getOne(conversationId)` — return full detail with messages and staged edits
- [X] T042 [US2] Implement `packages/backend/src/api/http/conversations.ts`: route handlers for `GET /api/conversations` (paginated per T041), `GET /api/conversations/:id`, `POST /api/conversations/:id/send`, `POST /api/conversations/:id/retry` (idempotent no-op-safe on a non-errored conversation rather than erroring)
- [X] T043 [US2] Implement `packages/backend/src/api/http/settings.ts`: `GET /api/settings` and `PATCH /api/settings` — read/write `user_settings` singleton; validate each field against its documented range (`revisionDebounceMs` 10,000–3,600,000; `maxConcurrentAgents` 1–10; `maxEditingDepth` 0–10; `maxConversationDepth` 1–10; `maxReplacementAttempts` 0–10; `thinkingVisible` boolean) and reject out-of-range values with `400 VALIDATION_FAILED` rather than clamping (FR-041); a changed limit takes effect immediately for subsequent operations and never retroactively closes, errors, or evicts conversations/proposals already exceeding it; emit `settings_changed` event on update

### Frontend — US2

- [X] T044 [US2] Implement `packages/frontend/src/stores/conversations.ts` (Pinia): state for conversation list and per-conversation message history; handle `conversation_status_changed`, `message_started`, `text_delta`, `thinking_delta`, `message_completed`, `agent_queued`, `agent_dequeued` events from WS
- [X] T045 [US2] Implement `packages/frontend/src/stores/settings.ts` (Pinia): load from `GET /api/settings`; persist via `PATCH /api/settings`; expose `thinkingVisible`, all limit values
- [X] T046 [US2] Implement `packages/frontend/src/components/hud/`: `HudPanel.vue` — conversation list with name, status badge, Primary indicator, stale indicator (`isStale`), pending-edit count badge, branch tree indentation; `packages/frontend/src/components/conversation/`: `ConversationView.vue` — message list; `MessageBubble.vue` — stream tokens into text; reasoning block collapsed by default, expand per `thinkingVisible` setting; all content sanitized before DOM insertion (FR-008a)
- [X] T047 [US2] Write `tests/e2e/us2.spec.ts`: Playwright spec — send message to Main, confirm streamed response, verify reasoning toggle, measure SC-001 (< 15 s first answer)

**Checkpoint**: US1 + US2 independently functional. Main conversation answers questions; no branching or proposals yet.

---

## Phase 5: User Story 3 — Branch from a selection and review proposed edits (P2)

**Goal**: The central review workflow — select → branch → agent proposes → user previews diff → accept/drop. Nothing changes in the document without explicit user action.

**Independent Test**: `npm run test:e2e -- --grep "US3"` — branch from selection, receive proposal, preview diff (both views), accept and verify revision, drop and verify document unchanged, bulk accept-remaining / drop-remaining, close blocked while pending.

### Backend — US3

- [X] T051 [US3] Extend `packages/backend/src/pi/document-tools.ts` with `propose_document_edit` tool: `defineTool({ name: 'propose_document_edit', parameters: proposeDocumentEditParams, execute: async (toolCallId, { summary, operations }) => ... })`; call `EditService.stage(conversationId, toolCallId, summary, operations, contextRevision)` for non-Primary conversations (returns staged result text); call `EditService.stageAndApplyPrimary(...)` for Primary (returns applied or conflict result text); depth check: reject tool with explanatory message when `branch_depth > max_editing_depth`, and omit from registered tool list (FR-026); acquire the conversation's document `PrimaryService` mutex for the duration of `execute` so a concurrent Primary-designation switch waits for this call to finish (http-api.md §POST /primary "mutually exclusive")
- [X] T052 [US3] Implement `packages/backend/src/edit/edit-service.ts`: `stage(...)` — insert `staged_edit` row (`status: 'pending'`); if the conversation has a pending "awaiting replacement" marker (set by `ConflictService.handleConflict`), link the new row via `supersedes_id` to that superseded original and clear the marker, without requiring the agent to pass `supersedes_id` itself (agent-tools.md §Conflict recovery — the agent never supplies it); emit `staged_edit_created`; `apply(editId)` — load edit + current document text, call `TextAnchor.reconcile(operations, text)`, on clean apply Automerge changes + create revision + mark `applied` + emit `staged_edit_applied` + `document_content_changed` + `revision_created`; on conflict call `ConflictService.handleConflict(edit, detail)`; `drop(editId)` — mark `dropped`, emit `staged_edit_dropped`; `acceptRemaining(conversationId)` — apply each pending edit in order, collect per-edit outcomes; `dropRemaining(conversationId)` — drop all pending edits; idempotency: if `apply` called on already-`applied` edit, return original result without re-applying (FR-040)
- [X] T053 [US3] Implement `packages/backend/src/edit/conflict-service.ts`: `handleConflict(edit, detail)` — mark edit `superseded`, record `conflict_detail`; if `edit.replacement_attempt < max_replacement_attempts`, set the conversation's "awaiting replacement" marker to `edit.id` (consumed by `EditService.stage` per T052) and ask agent for replacement via `PiService.send` with conflict detail injected into next message, emit `staged_edit_superseded` with `replacementRequested: true`; otherwise emit `staged_edit_superseded` with `replacementRequested: false` + emit `staged_edit_replacement_exhausted` (FR-032a, FR-032b); if the replacement-request call to `PiService.send` itself fails with an agent/model error (as opposed to succeeding and later conflicting), mark the conversation `errored` per FR-038 with the interruption visible, and leave the original proposal `superseded` rather than reverting it to `pending` — a subsequent retry (FR-038) re-issues the same replacement request against the same recorded `conflict_detail` and draws on the same replacement budget, never a fresh one (FR-032d)
- [X] T054 [US3] Implement `packages/backend/src/api/http/edits.ts`: route handlers for `GET /api/conversations/:id/edits`, `GET /api/edits/:id/preview` (calls `TextAnchor.reconcile` to compute `reconcilable` + `hunks` without applying), `POST /api/edits/:id/apply`, `POST /api/edits/:id/drop`, `POST /api/conversations/:id/edits/accept-remaining`, `POST /api/conversations/:id/edits/drop-remaining`
- [X] T055 [US3] Extend `packages/backend/src/api/http/conversations.ts`: add `POST /api/conversations` — branch from selection or parent; fork Pi session with `SessionManager.forkFrom(parent.pi_session_path, ...)`; seed first message with selection + surrounding context (FR-012); enforce `max_conversation_depth` (return `MAX_CONVERSATION_DEPTH_EXCEEDED`); reject if parent is closed (`CONVERSATION_CLOSED`); add `POST /api/conversations/:id/close` — reject if any staged edits `pending` (`PENDING_EDITS_BLOCK_CLOSE`); if `foldSummaryIntoParent`, call `PiService` to generate + deliver compact summary to parent; emit `conversation_closed` + `conversation_summary_folded`

### Frontend — US3

- [X] T056 [US3] Extend `packages/frontend/src/components/editor/`: add selection → branch action: button visible on non-empty selection, calls `POST /api/conversations` with `{ parentConversationId: mainId, selection: { from, to } }`; keyboard-operable equivalent (FR-043a) — no pointer required
- [X] T057 [US3] Implement `packages/frontend/src/stores/edits.ts` (Pinia): per-conversation staged edit state; handle `staged_edit_created`, `staged_edit_applied`, `staged_edit_dropped`, `staged_edit_superseded`, `staged_edit_replacement_created`, `staged_edit_replacement_exhausted` events
- [X] T058 [US3] Implement `packages/frontend/src/components/edits/`: `EditsList.vue` — pending proposals list with summary, source revision, status badge, superseded chain indicator; accept/drop per-proposal; `AcceptAllButton.vue` + `DropAllButton.vue` for bulk actions; show "budget exhausted" message when `staged_edit_replacement_exhausted` received
- [X] T059 [US3] Implement `packages/frontend/src/components/diff/`: `DiffViewer.vue` — calls `GET /api/edits/:id/preview`; renders full-document preview pane and added/removed hunks view (`diff` library); conveys changes without color alone (FR-043c — strikethrough + icons in addition to color); shows `conflictDetail` when `reconcilable: false`
- [X] T060 [US3] Write `tests/e2e/us3.spec.ts`: Playwright spec covering all eight US3 quickstart scenarios — branch, propose, preview (both views), accept, drop, bulk, act-while-active, close-blocked; verify document byte-identical before accept (SC-004)

**Checkpoint**: US1 + US2 + US3 independently functional. Core review workflow complete.

---

## Phase 6: User Story 4 — Keep a conversation in sync with a changing document (P2)

**Goal**: Conversations show staleness and the user can explicitly refresh context before sending.

**Independent Test**: `npm run test:e2e -- --grep "US4"` — start branch at v17, advance document to v20, confirm stale indicator, send without refresh (uses v17), refresh+send (uses v20).

### Backend — US4

- [X] T061 [US4] Extend `packages/backend/src/document/document-service.ts`: after any `revision_created` event, compute staleness for all non-closed conversations (`context_revision < document.current_revision`) and emit `conversation_stale` for each newly-stale one (FR-016)
- [X] T062 [US4] Extend `packages/backend/src/conversation/conversation-service.ts`: `refreshAndSend(conversationId, message)` — reject if `branch_depth > max_editing_depth` (`MAX_EDITING_DEPTH_EXCEEDED`); update `conversation.context_revision` to current document revision; determine `includedStagedEditIds` (proposals relevant to this conversation); deliver updated context to Pi session; emit `conversation_context_refreshed`; then send message
- [X] T063 [US4] Extend `packages/backend/src/api/http/conversations.ts`: add `POST /api/conversations/:id/refresh-send`

### Frontend — US4

- [X] T064 [US4] Extend `packages/frontend/src/components/hud/`: update `HudPanel.vue` to show stale badge on conversations where `isStale = true`; update `ConversationView.vue` to offer "Refresh + Send" (`Ctrl+Enter`) alongside normal "Send" (`Enter`) (FR-018); both keyboard shortcuts must be keyboard-operable equivalents (FR-043a)
- [X] T065 [US4] Write `tests/e2e/us4.spec.ts`: Playwright spec covering all four US4 scenarios

**Checkpoint**: US1–US4 independently functional.

---

## Phase 7: User Story 5 — Designate a Primary conversation for automatic edits (P3)

**Goal**: One optional Primary conversation whose proposals auto-apply through the same pipeline; switching with busy-state warning; Primary conflict → staged replacement.

**Independent Test**: `npm run test:e2e -- --grep "US5"` — Main Primary by default, auto-apply visible in history, switch Primary with warning (three choices), switch doesn't interrupt in-flight, Primary conflict → replacement staged for review.

### Backend — US5

- [X] T066 [US5] Implement `packages/backend/src/conversation/primary-service.ts`: enforce at-most-one-Primary invariant (partial unique index + service-level guard); reject `designate()` with an explanatory error when the target conversation's status is `errored` — an errored conversation MUST NOT be designated Primary (FR-038a); `designate(conversationId, whenBusy)` — if the target is already Primary, return a no-op success (`applied: 'already_primary'`) without emitting `primary_changed`; else if neither current Primary nor target is `working`, switch immediately (`applied: 'immediately'`); else if no `whenBusy`, return `PRIMARY_TARGET_BUSY` (409) with details; handle `switch_now`, `cancel`, `switch_when_idle` modes; `switch_when_idle` defers by registering a one-time listener on `agent_completed` for the busy conversation; at most one deferred switch may be pending at a time — a new designation request replaces any existing pending one; the pending deferred switch is cancelled without effect (no error surfaced, current Primary unchanged) if the target conversation closes or becomes errored before it takes effect (FR-029a); `clear(conversationId)` — set `is_primary = 0`, leave no replacement; `closeClears(conversationId)` — called by close flow to clear Primary without nominating replacement (FR-027a); emit `primary_changed` with `primaryConversationId: null` when cleared; hold a per-document mutex around the actual designation change so it serializes against any in-flight `propose_document_edit` execution (http-api.md §POST /primary "mutually exclusive") — a switch waits for the current tool call to finish, and a tool call that starts captures the Primary designation for its whole duration
- [X] T067 [US5] Extend `packages/backend/src/edit/edit-service.ts`: add `stageAndApplyPrimary(conversationId, toolCallId, summary, operations, contextRevision)` — create `staged_edit` row with `auto_applied: 0`, emit `staged_edit_created`, immediately call `TextAnchor.reconcile`; on clean: apply + create revision with `auto_applied: 1` + emit `staged_edit_applied(autoApplied: true)` + `document_content_changed` + `revision_created`; on conflict: call `ConflictService.handleConflict` — replacement arrives as a normal pending proposal for user review (FR-027)
- [X] T068 [US5] Extend `packages/backend/src/api/http/conversations.ts`: add `POST /api/conversations/:id/primary` (with `whenBusy`) and `DELETE /api/conversations/:id/primary`

### Frontend — US5

- [X] T069 [US5] Extend `packages/frontend/src/components/hud/`: add Primary badge and designation control on each conversation row; show warning dialog with three choices (switch now, cancel, switch when idle) when `409 PRIMARY_TARGET_BUSY` returned; show "no Primary" state clearly; update `staged_edit_applied` handler to distinguish `autoApplied: true` (no pending proposal shown, document updated immediately)
- [X] T070 [US5] Write `tests/e2e/us5.spec.ts`: Playwright spec covering all seven US5 scenarios — auto-apply audit trail, switch-while-busy three-choice warning, non-interruption, Primary conflict → staged replacement, plus a deferred "switch when idle" cancelled by the target erroring before it takes effect (FR-029a) and an attempt to designate an errored conversation Primary being rejected (FR-038a)

**Checkpoint**: US1–US5 independently functional. Full Primary/staged dichotomy implemented.

---

## Phase 8: User Story 6 — Resolve conflicts when applying an out-of-date proposal (P3)

**Goal**: Full conflict path for staged proposals: auto-reconcile → replace → budget-exhaust chain, all using the same `text-anchor` algorithm already in place.

**Independent Test**: `npm run test:integration -- --grep "reconcile"` + `npm run test:e2e -- --grep "US6"` — clean apply after document advance, `not_found` conflict → replacement, `ambiguous` conflict, chained replacement, budget exhaustion; manual edit always preserved (SC-005).

### Backend — US6

- [X] T071 [US6] Write `packages/backend/tests/integration/reconcile.test.ts`: integration tests for the full conflict pipeline using `FakePiSession` — clean reconcile, `not_found`, `ambiguous`, `overlapping`, chained replacement (replacement goes stale), budget exhaustion (including `maxReplacementAttempts: 0`); assert cross-entity invariants from `data-model.md §Cross-entity invariants` after each scenario
- [X] T072 [US6] Extend `packages/backend/src/edit/conflict-service.ts`: verify replacement chain: when a replacement proposal is itself superseded, increment `replacement_attempt` (up to cap), count against same originating budget (shared by the whole chain via `supersedes_id` ancestry); `getChainAttempts(editId)` — walk `supersedes_id` to find chain depth
- [X] T072a [US6] Extend `packages/backend/src/document/revision-service.ts` `restore(revisionNumber)`: before committing, run `TextAnchor.reconcile` for every `pending` staged_edit of the document against the would-be-restored content and collect `{ stagedEditId, reconcilable, conflictDetail? }` per proposal, without applying, superseding, or otherwise changing any staged_edit's status; include the array as `pendingProposalReconciliation` in the restore result (omitted when there are no pending proposals) (http-api.md §POST /revisions/:revision/restore)
- [X] T072b [US6] Extend `packages/backend/src/api/http/revisions.ts` `POST /api/revisions/:revision/restore` handler to pass through `pendingProposalReconciliation` from T072a in its `200` response

### Frontend — US6

- [X] T072c [US6] Extend `packages/frontend/src/components/history/HistoryPanel.vue` restore flow: when the restore response includes `pendingProposalReconciliation`, show which pending proposals in other conversations no longer reconcile against the restored content, so the user can decide per-proposal whether to keep waiting, apply, or drop it (http-api.md §POST /revisions/:revision/restore)
- [X] T073 [US6] Write `tests/e2e/us6.spec.ts`: Playwright spec covering all five US6 scenarios, plus restoring an earlier revision while a proposal is pending and confirming the dry-run reconciliation result is surfaced without altering the proposal's status

**Checkpoint**: US1–US6 independently functional. Complete edit lifecycle verified.

---

## Phase 9: User Story 7 — Review closed conversations (P4)

**Goal**: Closed conversations are read-only, browsable, and can be independently reviewed by a new agent without being mutated.

**Independent Test**: `npm run test:e2e -- --grep "US7"` — close conversation with summary fold, view closed conversation (readonly mode, branch/primary disabled), request review (closed conversation unchanged after).

### Backend — US7

- [X] T074 [US7] Extend `packages/backend/src/conversation/conversation-service.ts`: `close(conversationId, foldSummaryIntoParent)` — validate no pending staged edits (FR-033); set `status: 'closed'`, `closed_at`; MUST NOT close, error, or otherwise mutate any still-open child conversation of the one being closed — children keep their historical branch link to the now-closed, read-only parent but remain fully open and usable (FR-035a); if `is_primary`, call `PrimaryService.closeClears(conversationId)` within same transaction; if `foldSummaryIntoParent`, reject if the parent has itself since closed (option not offered/accepted, FR-034a); otherwise ask Pi to generate a compact summary via `session.sendCustomMessage({ deliverAs: 'nextTurn' })` into the parent session (research R1, FR-034) containing the closed conversation's name, its seeded selection (if any), a synopsis of what was discussed/decided, and the list of proposals it produced with each one's final status (applied/dropped/superseded) and any resulting revision number — MUST NOT include the full raw message transcript (FR-034a); emit `conversation_closed` + `conversation_summary_folded`; `getOne(closed)` — return with `readOnly: true`; `review(conversationId)` — validate target is closed; create new `kind: 'review'` conversation seeded with closed transcript via `SessionManager.open(closedPath)` + `getEntries()`; emit `conversation_started`
- [X] T075 [US7] Extend `packages/backend/src/api/http/conversations.ts`: `POST /api/conversations/:id/review` (409 if not closed)

### Frontend — US7

- [X] T076 [US7] Extend `packages/frontend/src/components/hud/` and `packages/frontend/src/components/conversation/`: render closed conversations with `readOnly` indicator; disable branch, primary, send, refresh-send controls for closed conversations; offer "Request review" action; "Fold summary" offered at close time via close dialog
- [X] T077 [US7] Write `tests/e2e/us7.spec.ts`: Playwright spec covering all three US7 scenarios, plus closing a parent conversation with an open child and confirming the child remains open, usable, and unaffected (FR-035a)

**Checkpoint**: All seven user stories implemented and independently testable.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Restart recovery, concurrency/disconnect hardening, accessibility audit, contract tests, Docker validation, and quickstart sign-off.

### Restart recovery and error handling

- [X] T078 [P] Implement startup recovery in `packages/backend/src/server.ts`: on boot, query all conversations with `status: 'working'` → set `status: 'errored'`, `error_message: 'Interrupted by application restart'`, emit `conversation_status_changed` (FR-039a); load Automerge state from snapshots + changes; verify document `current_revision` matches latest `revision` row
- [X] T079 [P] Harden disconnect handling in `packages/backend/src/api/ws/index.ts`: on socket close, unsubscribe from EventHub only — never mark any agent or conversation errored; mid-run `RunBuffer` persists the partial response independently of socket state (FR-037)

### Concurrency and queueing

- [X] T080 [P] Write `packages/backend/tests/integration/concurrency.test.ts`: integration tests using `FakePiSession` — three simultaneous runs succeed; fourth prompt is queued (not rejected); queue position reported via `agent_queued` event; queue drains in FIFO order; `agent_error` on one run leaves queue intact

### Accessibility (WCAG 2.2 AA)

- [X] T081 [P] Implement `packages/frontend/src/a11y/live-regions.ts`: ARIA live regions for agent status changes — `agent_started`, `message_completed`, `staged_edit_created`, `conversation_stale`, `agent_error` — announced to assistive technology without moving focus (FR-043b)
- [X] T082 [P] Implement `packages/frontend/src/a11y/focus-manager.ts`: manage focus transitions between editor, conversation panel, diff viewer, and any blocking dialog (confirm close, busy-switch warning); implement `packages/frontend/src/a11y/keymap-registry.ts`: register all keyboard shortcuts; ensure select-from-keyboard → branch action works without mouse (FR-043a)
- [X] T083 [P] Audit all interactive components in `packages/frontend/src/components/` for WCAG 2.2 AA: correct ARIA roles and labels on editor, HUD, conversation, diff viewer, history panel, revision list; sufficient color contrast; status badges convey meaning beyond color; diff hunks use strikethrough + icon in addition to color (FR-043c)
- [X] T084 Write `tests/e2e/a11y.spec.ts`: Playwright spec — complete core loop (paste, edit, branch, preview diff, accept) keyboard-only with no mouse; verify live-region announcements; automated contrast/roles audit over each main view; run with `npm run test:e2e -- --grep "a11y"`

### Contract tests

- [X] T085 [P] Write `packages/backend/tests/contract/http.test.ts`: for every HTTP endpoint validate response against shared Zod schema from `packages/shared/src/contracts/http.ts`; assert each documented error code at its boundary condition; verify `isStale`, `canEdit`, `canBranch`, `pendingEditCount` are server-computed and vary correctly (`pendingEditCount` excludes `superseded` proposals, FR-032c); cover all five `POST /api/edits/:id/apply` outcomes (clean, conflict, conflict-budget-exhausted, already-applied idempotent, not-pending); assert `GET /api/conversations` and `GET /api/revisions` pagination (`cursor`/`limit`/`nextCursor`, stable ordering across pages); assert `PATCH /api/settings` rejects each out-of-range value with `400 VALIDATION_FAILED` at its documented boundary; assert document creation without an explicit `title` defaults to the first H1 heading or `"Untitled"` (FR-001a); assert `POST /api/conversations/:id/retry` on a non-errored conversation and `POST /api/conversations/:id/primary` on the already-Primary conversation both behave as documented rather than erroring unexpectedly
- [X] T086 [P] Write `packages/backend/tests/contract/ws.test.ts`: validate every WebSocket event type against shared Zod union from `packages/shared/src/contracts/events.ts`; assert reconnect replay is gap-free and non-duplicating; assert `staged_edit_created` always precedes verdict events, including on the Primary auto-apply path; assert `staged_edit_superseded` always precedes `staged_edit_replacement_created` or `staged_edit_replacement_exhausted` (ordering guarantee 7); assert `agent_started` always precedes any `staged_edit_created` from a tool call in that run (ordering guarantee 8); assert ephemeral deltas are absent from `conversation_event` rows and are the only frame type dropped once `bufferedAmount` exceeds 1MB; assert `thinkingVisible` toggle affects subsequent frames only; assert `document_content_changed` carries a `contentHash` matching SHA-256 of the resulting content
- [X] T087 [P] Write `packages/backend/tests/contract/live-pi.test.ts` tagged with a dedicated Vitest project/tag (`test.live-pi`), excluded from the default `npm run test:*` scripts, opt-in via `npm run test:contract:live` gated on `PI_LIVE_TEST=1` and run only in a separate CI job (agent-tools.md §Contract test expectations item 10): assert real Pi SDK emits every event type the event-bridge mapping table requires; confirm `noTools: 'all'` leaves no built-in tool in `session.getActiveToolNames()`

### Logging

- [X] T088 [P] Audit `packages/backend/src/logging.ts` and all service modules: every `event` field value must match the closed vocabulary in `contracts/websocket-events.md`; log records for errors, conversation lifecycle changes, and edit applications must be present; verify no document content or agent message text is logged at `info` level or below (FR-042)

### Docker and deployment

- [X] T089 Write `docker/Dockerfile` final pass: verify no native-module build steps; `node:sqlite` is built-in; Vite frontend build output copied to backend static dir; image starts with `node src/server.js`; `docker/docker-compose.yml`: `ports: ["127.0.0.1:3000:3000"]` enforces loopback-only even in Docker (FR-044). Reviewed `docker/Dockerfile` and `docker/docker-compose.yml`: no changes needed. Confirmed no native-module build step exists anywhere in `node_modules` (no `binding.gyp` in the tree; `@automerge/automerge` ships prebuilt `.wasm`; the two packages with lifecycle install scripts — `@google/genai`, `protobufjs`, both transitive via `@earendil-works/pi-coding-agent` — only run trivial JS postinstall/no-op scripts, no compilation). Confirmed `CMD ["node", "packages/backend/dist/server.js"]` matches the real `tsc -b` output (`outDir: dist`, `rootDir: src`) and `packages/backend/package.json`'s `main`. Confirmed the runtime stage's `npm ci --omit=dev --workspace=packages/shared --workspace=packages/backend` succeeds even though only `packages/shared` and `packages/backend` package.json files are copied in (verified by reproducing that exact step outside Docker). Confirmed `docker-compose.yml` sets `HOST=127.0.0.1` (required by `config.ts`, which throws if HOST is anything else) and `ports: ["127.0.0.1:3000:3000"]` (loopback-only host binding, not `0.0.0.0` or bare `3000:3000`). Confirmed `DATABASE_PATH=/data/document-review.sqlite` and `PI_SESSION_STORAGE_PATH=/data/pi-sessions` both live under the mounted `app-data` volume and match `config.ts`'s exact env var names. **Note (not fixed, out of scope):** `packages/backend/src/server.ts` never registers `@fastify/static` (not even a dependency) or any route serving `dist/public` — the Dockerfile correctly copies the Vite build there, but nothing in the backend serves it yet, so `GET /` 404s. This is a real gap for a working deployment but is server.ts feature work, not a Dockerfile/compose defect, so it was left to whichever task owns static-file-serving.
- [ ] T090 Run deployment validation from `quickstart.md §Deployment validation`: `docker compose up --build`, confirm app at `127.0.0.1:3000`, restart container confirming document/revisions/conversations survive, verify logs are JSON with correct `event` vocabulary, confirm port unreachable from another network device. **Left unchecked: Docker is not available in this sandbox** (`docker: command not found`, no daemon) so `docker compose up --build` could not be run. Performed the closest static equivalent instead: ran `npm run build` (all three workspaces built cleanly), copied `packages/frontend/dist` into `packages/backend/dist/public` exactly as the Dockerfile does, then ran the compiled server directly (`node packages/backend/dist/server.js`) with the same env vars the compose file sets (`HOST=127.0.0.1`, `PORT`, `DATABASE_PATH`, `PI_SESSION_STORAGE_PATH`, `PI_CODING_AGENT_DIR`, `LOG_LEVEL=info`) pointed at a scratch data directory. Verified: (1) `curl 127.0.0.1:<port>/healthz` and `/api/document` succeed; (2) `/proc/net/tcp` shows the listening socket bound to `0100007F` (127.0.0.1) only, and a request to the container's non-loopback IP fails to connect — confirms loopback-only binding; (3) logs are one JSON object per line via pino, and app-level records carry an `event` field matching the closed vocabulary (observed `document_created`, `revision_created`) with no document content or message text logged; (4) killed and restarted the server against the same `DATABASE_PATH` file — `GET /api/document`, `/api/conversations`, and `/api/revisions` afterward showed the identical document, Main conversation (still Primary), and revision `v1`, confirming restart persistence. **Not verified live: the actual containerized build/runtime** (image build, container restart via `docker compose restart`, and "unreachable from another device on the network" specifically through Docker's port-publishing layer) — only the equivalent host-process behavior was checked. Someone with Docker access should still run the literal `docker compose up --build` flow before shipping.

### Final sign-off

- [X] T091 Run complete quickstart validation. `npm test` (unit 7 + integration 11 + contract 78 = 96 tests) green with no provider credential, `PI_FAKE_SESSIONS=1` throughout. All 13 e2e specs (US1–US7 across 10 tests, plus 3 a11y tests) pass via `npx playwright test`, run twice back-to-back for stability — 13/13 both times. Cross-cutting scenarios: concurrency (FIFO queueing + error isolation, `concurrency.test.ts`), disconnect (unsubscribe-only + RunBuffer replay, `ws.test.ts`), restart recovery (`working`→`errored` on boot, FR-039a — covered by inspection/unit-level design, not re-exercised by an actual process restart in this run), failure/retry (US5's `ERROR_DIRECTIVE` scenarios + `retry` no-op contract test), idempotency (`apply` on an already-applied edit, FR-040, in both `http.test.ts` and `reconcile.test.ts`), depth limits (`MAX_EDITING_DEPTH_EXCEEDED`/`MAX_CONVERSATION_DEPTH_EXCEEDED` boundary tests), accessibility (`a11y.spec.ts`, WCAG 2.2 AA), no-document edge case (us1.spec.ts's paste screen — required reordering the Playwright suite into a `stories` project that an `a11y` project depends on, since it's the only spec allowed to see the pristine empty-document state in this shared-backend-per-run architecture; see `playwright.config.ts`). SC-001–SC-009: SC-001 (<15s first answer) and SC-002 (<10s branch response) pass as measured against `FakeAgentSession` (near-instant) — this is NOT a measurement of live-model latency, since no provider credential exists in this sandbox; a true SC-001/002 measurement requires T092's live run or a staged deployment. SC-003 (diff review clarity) and SC-004 (0% silent edits, auto-apply distinguishable) are structurally satisfied by DiffViewer.vue/EditsList.vue and exercised in us3/us5 e2e. SC-005 (never a silent loss) is exhaustively covered by `reconcile.test.ts`'s conflict/clean matrix. SC-006 (5s reconnect) is functionally covered (gap-free replay incl. mid-run buffered text, `ws.test.ts`) but not independently timed against a 5s budget. SC-007 (3 concurrent conversations, <100ms p95 keystroke, <200ms conversation switch) has no dedicated performance harness in this codebase — not measured; would need real browser perf instrumentation, out of scope for this pass. SC-008 (revision origin always identifiable) is covered by HistoryPanel's `origin`/`conversationName` columns and the Primary auto-apply badge. SC-009 (closed conversation fully intact on reopen) is covered by us7.spec.ts. Net: full functional/correctness coverage achieved; the two criteria requiring a live model or a dedicated perf harness (parts of SC-001/002/007) are honestly flagged as unmeasured here rather than claimed.
- [ ] T092 Run `npm run test:contract:live` with `PI_LIVE_TEST=1` and a real provider credential; confirm `FakePiSession` has not drifted from real Pi SDK event types. **Left unchecked: no real Pi/model provider credential is available in this sandbox.** `live-pi.test.ts` is fully written and correctly gated (`describe.skipIf(process.env.PI_LIVE_TEST !== '1')`, excluded from the default `npm run test:contract` via `--exclude '**/live-pi.test.ts'`) and ready to run as soon as a credential is available — someone with provider access should run `npm run test:contract:live` before shipping to confirm `FakePiSession` hasn't drifted from the real SDK's event shapes.

**Checkpoint**: All definition-of-done items in `quickstart.md` satisfied.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — **blocks all user story phases**
- **Phase 3 (US1)**: Depends on Phase 2 only
- **Phase 4 (US2)**: Depends on Phase 2 only — can start in parallel with Phase 3
- **Phase 5 (US3)**: Depends on Phase 4 (needs ConversationService, PiService, EditService shares the same Automerge/Anchor foundation)
- **Phase 6 (US4)**: Depends on Phase 5 (staleness builds on conversation context established in US3)
- **Phase 7 (US5)**: Depends on Phase 5 (PrimaryService modifies the edit application path)
- **Phase 8 (US6)**: Depends on Phase 5 — conflict path is exercised via edit-service already in place
- **Phase 9 (US7)**: Depends on Phase 5 (close flow, session reads)
- **Phase 10 (Polish)**: Depends on Phases 3–9

### User story dependencies

- **US1 (P1)**: Phase 2 only — fully independent
- **US2 (P1)**: Phase 2 only — can develop in parallel with US1
- **US3 (P2)**: US2 must be complete (PiService, ConversationService, event stream already functional)
- **US4 (P2)**: US3 must be complete (staleness is a cross-conversation concern)
- **US5 (P3)**: US3 must be complete (Primary modifies the edit application path)
- **US6 (P3)**: US3 must be complete (conflict path uses the same EditService)
- **US7 (P4)**: US3 must be complete (close, read closed sessions)

### Within each user story

- Shared contracts (Phase 2: T006–T009) before any backend or frontend task
- `text-anchor.ts` (T015) before `EditService` (T052) — the reconciler is the foundation
- Backend route handlers after their service dependencies
- Frontend stores before components
- E2E specs last (test what the full stack delivers)

---

## Parallel Execution Examples

### Phase 2 — Foundational (run together after T012 → T013 sequential)

```
T006 (domain types) || T007 (http.ts) || T008 (events.ts) || T009 (agent-tools.ts)
→ T012 (StorageAdapter interface) → T013 (SQLite impl + migrations)
T010 (logging) || T011 (config) || T014 (automerge-store) || T015 (text-anchor) || T017 (FakePiSession)
T016 (text-anchor unit tests) → depends on T015
T018 (event-service) || T019 (run-buffer) → both depend on T013
T020 (event-hub) → depends on T018 + T019
```

### Phase 3 — US1 (backend and frontend in parallel once T014 is done)

```
T021 (document-service) || T027 (markdown-pipeline) || T029 (document store + http-client)
→ T022 (revision-service) depends on T021
→ T023 (http/document routes) depends on T021 + T022
→ T024 (http/revisions routes) depends on T022
→ T030 (ws-client) depends on T029
T028 (mermaid + svg extensions) || T031 (App.vue + main.ts)
→ T032 (editor) || T033 (preview) → depend on T031
→ T034 (history panel) → depends on T024 + T034
→ T035 (e2e/us1) → depends on all US1 tasks
```

### Phase 10 — Polish (all parallelizable tasks run together)

```
T078 (restart recovery) || T079 (disconnect hardening) || T080 (concurrency tests)
|| T081 (live-regions) || T082 (focus-manager + keymap)
|| T083 (component a11y audit) || T085 (http contract tests)
|| T086 (ws contract tests) || T088 (log audit) || T089 (docker final)
→ T084 (a11y e2e) → depends on T081–T083
→ T087 (live-pi contract) → depends on T086
→ T090 (deployment validation) → depends on T089
→ T091 (full sign-off) → depends on all
→ T092 (live-pi sign-off) → depends on T087 + T091
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks everything)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: `npm run test:e2e -- --grep "US1"` must pass
5. Demo: Markdown editor with tracked history, restore, export, and XSS-safe rendering

### Incremental Delivery

1. Setup + Foundational → `npm run db:migrate` + `npm run dev` working
2. + US1 → Markdown editor with history (independently valuable)
3. + US2 → Talk to Main about the document (core value proposition)
4. + US3 → Branch, propose edits, review diff, accept/drop (central review workflow — **this is the product**)
5. + US4 → Staleness + refresh (trust maintenance)
6. + US5 + US6 → Primary auto-apply + conflict recovery (power user / trust features)
7. + US7 → Closed conversation browse + review (accountability)
8. + Polish → Production-ready: WCAG 2.2 AA, contract tests, Docker

### Parallel Team Strategy

With two developers, after Phase 2 is complete:
- **Developer A**: US1 (backend + frontend) → US3 backend → US5/US6
- **Developer B**: US2 (backend + frontend) → US3 frontend → US4 → US7

---

## Notes

- `[P]` tasks operate on different files with no dependency on incomplete siblings — safe to launch together
- Each user story phase is a complete, independently testable increment; stop at any checkpoint to validate and demo
- `FakePiSession` (T017) is the key infrastructure enabling deterministic integration tests without a live Pi/model credential
- `text-anchor.ts` (T015) and its unit tests (T016) are the load-bearing algorithm for the entire conflict-resolution feature; get them right before building edit services
- Accessibility (T081–T084) is a release gate, not an afterthought — WCAG 2.2 AA is the stated conformance level (FR-043)
- Never log document content or agent message text at a level that appears in standard `npm run dev` output (FR-042 + privacy)
- The Primary-designation mutex (T066, T051) and the restore dry-run reconciliation (T072a–T072c) are both later additions to `contracts/http-api.md`; they extend T022/T034 (US1) and T051/T066 (US3/US5) rather than replacing them — implement them once those base tasks exist
- A second architecture-review pass folded FR-001a/FR-008b/c/FR-015a/FR-029a/FR-032c/d/FR-034a/FR-035a/FR-037b/FR-038a and several contract clarifications (pagination, settings validation ranges, content-hash divergence, queue re-emission, event-bridge late-event handling, operations cap, live-Pi test script name) into the existing tasks above and one new task, T030a (reconnecting indicator) — no task IDs were renumbered
- One known gap surfaced during that pass: `contracts/http-api.md`'s `PATCH /api/document` example doesn't yet show the `title` field T023 relies on for FR-001a renaming — worth a small contract-doc addition in a future pass, but not blocking implementation
- Commit after each task or logical group; each user story phase should be its own PR milestone
