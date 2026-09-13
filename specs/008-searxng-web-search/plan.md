# Implementation Plan: SearXNG Web Search and Page Fetch for the Review Agent

**Branch**: `008-searxng-web-search` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-searxng-web-search/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Adds two new read-only, custom Pi tools — `web_search` and `web_fetch` — registered in
`PiService.buildTools()` (`app/backend/src/pi/pi-service.ts`) alongside the existing
`read_document`/`propose_document_edit` tools, following the identical `customTools` registration
mechanism (no Pi extension, per Principle VII and the amended v1 non-goal in the constitution,
v2.2.0). `web_search` calls a self-hosted SearXNG instance's JSON search API; `web_fetch` retrieves
a given URL and returns extracted page text. Neither tool touches document state or the
edit-proposal pipeline (Principle III N/A — no mutation path exists for them). The devcontainer is
converted from a single-container `build` definition to a Docker Compose–based devcontainer
(`.devcontainer/docker-compose.yml`) adding a `searxng` service (the official `searxng/searxng`
image) on the same Docker network as the app container, with a mounted `settings.yml` enabling the
JSON output format SearXNG disables by default. Both tools are read-only and unit/contract-tested
against a local HTTP stub, not a live SearXNG instance, so the default test suite stays
credential-free and network-free (mirroring `RADR_BE_PI_FAKE_SESSIONS`).

## Technical Context

**Language/Version**: TypeScript (Node.js, `--experimental-strip-types`, no build step in dev) for
the backend; the devcontainer/compose layer is Docker/YAML configuration, no new language.

**Primary Dependencies**: `@earendil-works/pi-coding-agent` (existing sole Pi SDK dependency,
Principle II — `customTools` registration, unchanged usage pattern); a new lightweight `html-to-text`
dependency for `web_fetch`'s HTML → plain-text extraction (research.md R3); Node's built-in `fetch`
for both tools' outbound HTTP calls (no new HTTP client dependency). Infrastructure: the official
`searxng/searxng` Docker image, added as a devcontainer Compose service.

**Storage**: N/A — both tools are stateless per call; their results are ephemeral (surfaced to the
agent and the conversation transcript only, per spec.md Key Entities), never persisted to SQLite or
any other store.

**Testing**: Vitest (`app/backend/tests/unit`, `tests/contract`). New tool objects are exercised
directly (calling `.execute(...)`, the same pattern `FakeAgentSession`'s directive handlers already
use for `read_document`/`propose_document_edit`) against a local HTTP stub standing in for SearXNG
and for a fetched page (research.md R5) — no live SearXNG instance or live internet access required
for `npm run test:*`. An opt-in `test:contract:live`-style suite, gated the same way the existing
live-Pi contract test is (`PI_LIVE_TEST=1`-style env var), MAY separately validate against the
devcontainer's real SearXNG instance.

**Target Platform**: Linux devcontainer (Docker Compose) for development; Linux server /
self-hosted Docker deployment for production — both now bundle their own `searxng` service
(spec.md Assumptions), sharing `docker/searxng/settings.yml`; the endpoint remains
operator-configurable via `RADR_BE_SEARXNG_URL` regardless.

**Project Type**: Web application backend (single Node/TypeScript backend package within the
existing frontend+backend monorepo) plus a devcontainer infrastructure change. No frontend changes
(tool activity surfaces through the existing conversation event stream/UI, unchanged).

**Performance Goals**: N/A beyond "does not stall a conversation turn" — FR-012 bounds fetched
content size, and both tools apply a bounded timeout (research.md R4/R6) so a slow/unreachable
backend fails fast rather than hanging.

**Constraints**: MUST NOT introduce a Pi extension (Principle VII); MUST NOT allow either tool to
participate in the edit-proposal pipeline (Principle III); MUST keep the default test suite
credential-free and network-independent (mirrors existing `RADR_BE_PI_FAKE_SESSIONS` philosophy);
new environment variables MUST use the `RADR_BE_` prefix (Technology & Platform Constraints).

**Scale/Scope**: Additive change confined to `app/backend/src/pi/` (new tool module,
`pi-service.ts` registration), `app/shared/src/contracts/agent-tools.ts` (new param schemas),
`app/backend/src/config.ts` (new search-endpoint config), and `.devcontainer/` (compose
conversion + SearXNG settings overlay). No schema/storage changes, no new HTTP/WebSocket endpoints,
no frontend changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle II (Pi Owns Agent Conversations)**: Both tools are registered exclusively through the
  existing `customTools` mechanism in `PiService.buildTools()`; nothing reads or writes Pi's session
  storage format, and no new import of `@earendil-works/pi-coding-agent` is introduced outside
  `pi-service.ts`/`pi/tools/*`'s existing pattern (the new tool modules follow the same
  `defineTool()`-wrapping shape the existing tools use). **PASS.**
- **Principle III (Agent Edits Are Proposals, Not Direct Writes)**: Neither `web_search` nor
  `web_fetch` can modify the document — they have no path into `EditService` or the staged-edit
  pipeline at all, unlike `propose_document_edit`. Not applicable rather than merely satisfied.
  **PASS.**
- **Principle V (Configurable Limits Are Enforced, Not Advisory)**: FR-012's content-size bound and
  the tool timeouts (research.md R4/R6) are enforced unconditionally inside the tool implementation,
  not advisory. **PASS.**
- **Principle VII (No Pi Extension Without Demonstrated Necessity)**: No Pi extension is introduced;
  both tools are plain `customTools`, identical in kind to `read_document`. **PASS.**
- **Technology & Platform Constraints — v1 non-goals**: As of constitution v2.2.0, the "additional
  agent tools beyond document read/edit" non-goal is explicitly narrowed to carve out `web_search`
  and `web_fetch`. **PASS** (this plan is the first consumer of that carve-out — see
  `.specify/memory/constitution.md`'s Sync Impact Report for v2.1.0 → v2.2.0).
- **Technology & Platform Constraints — environment variable naming**: The new search-endpoint
  config variable is `RADR_BE_SEARXNG_URL` (application-defined, `RADR_BE_`-prefixed). **PASS.**
- No other principle (I, IV, VI) is implicated — this feature does not touch document ownership,
  CRDT/revisions, or the Markdown rendering pipeline.

No violations. Complexity Tracking section is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/008-searxng-web-search/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── web-tools.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
.devcontainer/
├── devcontainer.json           # converted: dockerComposeFile + service (was build:) — US2
├── docker-compose.yml          # new: app + searxng services on one Docker network — US2
└── searxng/
    └── settings.yml            # new: enables JSON output format (disabled in SearXNG by default) — US2

app/shared/src/contracts/
└── agent-tools.ts              # add webSearchParams / webFetchParams Zod schemas

app/backend/
├── src/
│   ├── config.ts                # add RADR_BE_SEARXNG_URL (+ tool timeout) config fields
│   └── pi/
│       ├── pi-service.ts        # buildTools() registers all four tools alongside each other
│       └── tools/                # new: colocates every agent tool (was document-tools.ts)
│           ├── common.ts            # new: shared result-shaping/bounding helpers (see below)
│           ├── read-document.ts          # createReadDocumentTool (moved as-is)
│           ├── propose-document-edit.ts  # createProposeDocumentEditTool (moved as-is)
│           ├── web-search.ts             # new: createWebSearchTool
│           ├── web-fetch.ts              # new: createWebFetchTool
│           └── index.ts                  # barrel re-exporting all four factories
└── tests/
    ├── unit/                    # tools/web-search.ts, tools/web-fetch.ts behavior against a local HTTP stub
    └── contract/                 # tool registration + end-to-end tool.execute() via PiService.buildTools()

README.md                        # document RADR_BE_SEARXNG_URL and the devcontainer's SearXNG service
```

**Structure Decision**: No new backend services or packages. The devcontainer moves from a
single-container `build` definition to a Compose-based devcontainer (the standard `containers.dev`
pattern for adding a sibling service) so SearXNG runs as its own container reachable by service name
(`http://searxng:8080`) without requiring Docker-in-Docker inside the dev container
(research.md R1). `document-tools.ts` is split and moved into `pi/tools/` (one file per tool, plus
an `index.ts` barrel) so the two new tools are colocated with the existing ones rather than growing
a second same-shaped file alongside it; `pi-service.ts`'s single import site
(`pi-service.ts:16`) changes from `./document-tools.ts` to `./tools/index.ts`, and every tool still
registers through the same `PiService.buildTools()` chokepoint. `pi/tools/common.ts` factors
out the result-shaping and bounding logic that would otherwise be duplicated across all four tool
files (research.md R7): a `textResult(text, details?)` helper for the `{content: [{type: 'text',
text}], details}` shape every tool's `execute` already returns today, and a `clampWithNote(...)`
helper generalizing `read-document.ts`'s existing clamp-and-note pattern for `web_fetch`'s
truncation (FR-012).

## Complexity Tracking

*(No Constitution Check violations — section not needed.)*
