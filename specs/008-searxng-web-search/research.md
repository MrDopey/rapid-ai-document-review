# Phase 0 Research: SearXNG Web Search and Page Fetch for the Review Agent

No `[NEEDS CLARIFICATION]` markers remain in the spec (see spec.md Assumptions), and the
constitution gate that blocked this feature (the "additional agent tools" v1 non-goal) was resolved
by amending the constitution to v2.2.0 before this plan was written. This research resolves the
remaining implementation-level unknowns needed to design Phase 1 correctly.

## R1: How does SearXNG get added to a single-container devcontainer?

- **Decision**: Convert `.devcontainer/devcontainer.json` from a plain `build` definition to
  `dockerComposeFile: ["docker-compose.yml"]` + `service: "app"`, and add a new
  `.devcontainer/docker-compose.yml` with two services: `app` (the existing `Dockerfile`, now
  referenced from compose) and `searxng` (the official `searxng/searxng` image), sharing one Compose
  network so the app container reaches SearXNG at `http://searxng:8080`.
- **Rationale**: This is the standard `containers.dev` pattern for "add a sibling service" (the same
  shape commonly used for a database or cache alongside a devcontainer). It requires no
  Docker-in-Docker capability inside the dev container itself — both containers are started
  side-by-side by the devcontainer CLI/VS Code directly against the host's Docker engine, exactly
  like `docker/docker-compose.yml`'s existing `app` service is started for production.
- **Alternatives considered**:
  - Docker-in-Docker feature + `docker run searxng/searxng` from `postCreateCommand` — rejected:
    requires enabling a Docker-outside-of-Docker/Docker-in-Docker feature and a socket mount not
    currently present in `devcontainer.json`, is less idiomatic for devcontainers, and ties SearXNG's
    lifecycle to a shell script instead of the container orchestrator already responsible for the
    app container's lifecycle.
  - Installing SearXNG's Python/uwsgi stack directly into the existing Node `Dockerfile` — rejected:
    couples an unrelated Python search stack into the Node app image, forces manual tracking of
    SearXNG upstream updates instead of pulling `searxng/searxng` releases, and complicates the
    image for a capability that is conceptually a separate service, not part of the app runtime.

## R2: Why can't the app just call SearXNG's default `/search` endpoint?

- **Decision**: Mount a `docker/searxng/settings.yml` overlay (via a compose `volumes` entry into
  the `searxng` container, read-only) that sets `search.formats: [html, json]` and a fixed,
  non-placeholder `server.secret_key`. Shared as-is by both `docker/docker-compose.yml`
  (production, which now also bundles a `searxng` service rather than requiring an
  externally-provided one) and `.devcontainer/docker-compose.yml` (dev), rather than maintaining
  two copies.
- **Rationale**: SearXNG ships with only `html` (and `rss`) enabled in `search.formats` by default —
  requesting `?format=json` against a stock instance returns a 403, since JSON output is treated as
  an API surface that must be explicitly opted into. `secret_key` has no environment-variable
  override — it is only ever read from `settings.yml`
  (docs.searxng.org/admin/settings/settings.html) — and the image's own entrypoint only
  auto-generates a random one when `settings.yml` doesn't already exist at container start; since
  our overlay is always mounted in, that auto-generation path never runs, so the fixed value in the
  overlay is what applies, and it stays stable across restarts (a per-start random key would
  invalidate sessions on every container restart). A read-only mount is safe here specifically
  because the entrypoint never rewrites a settings.yml that already exists — it does not need
  write access to this file at all.
- **Alternatives considered**: Screen-scraping the HTML results page instead of using `format=json`
  — rejected: far more brittle (couples the tool to SearXNG's HTML markup), and JSON output is the
  documented, intended integration surface once enabled.

## R3: How does `web_fetch` turn a fetched page into text?

- **Decision**: Add `html-to-text` (a small, dependency-light HTML → plain-text converter with no
  DOM parser) as a new `app/backend` dependency, used only inside `pi/tools/web-fetch.ts`'s
  implementation.
- **Rationale**: `web_fetch` needs to hand the agent readable text, not raw markup. `html-to-text`
  does this directly from the response body with no DOM construction step, keeping the dependency
  footprint proportional to the actual need (strip tags/scripts/styles, preserve basic structure).
- **Alternatives considered**:
  - `@mozilla/readability` + a DOM shim (`linkedom`/`jsdom`) — rejected: designed for "reader mode"
    single-article extraction, which can be *more* aggressive than desired (dropping content the
    agent may still want, e.g. a table or a short reference page that doesn't look like a long-form
    article), and pulls in a full DOM parser dependency for a need that doesn't require one.
  - Hand-rolled tag-stripping (regex-based) — rejected: unreliable around `<script>`/`<style>`
    content and HTML entities; would end up re-implementing a worse version of an existing,
    maintained library.

## R4: How is fetched/result content kept bounded (FR-012)?

- **Decision**: `web_fetch` truncates its returned text to a fixed character bound (e.g. 20,000
  characters), appending a clear truncation note when it does — the same "clamp and note" shape
  `pi/tools/read-document.ts`'s `renderReadResult` already uses for out-of-range line requests. `web_search`
  caps the number of results it requests/returns per query to a small fixed count (e.g. top 8),
  since SearXNG's own JSON response can otherwise return far more than an agent needs to reason
  over in one tool result.
- **Rationale**: Reuses an existing, proven pattern in this codebase (clamp + explanatory note)
  rather than inventing a new one, and keeps both bounds as code constants rather than new
  operator-facing configuration — the spec does not ask for either to be tunable per deployment
  (YAGNI).

## R5: How are `web_search`/`web_fetch` tested without a live SearXNG instance or live internet?

- **Decision**: Unit- and contract-test the tool objects directly — call `.execute(...)` the same
  way `FakeAgentSession`'s `runReadDocumentDirective`/`runProposeEditDirective` already invoke real
  tool objects internally — against a local HTTP stub (Node's built-in `http.createServer`, scoped
  to the test) standing in for both the SearXNG JSON endpoint and a fetched page. `FakeAgentSession`
  itself is not extended with a new directive protocol for these tools, since nothing about
  exercising them requires scripting a simulated model turn end-to-end; testing the tool objects
  directly is simpler and sufficient.
- **Rationale**: Keeps `npm run test:*` credential-free and network-independent, consistent with
  `RADR_BE_PI_FAKE_SESSIONS`'s existing rationale (README.md). A live-SearXNG opt-in suite, gated the
  same way the existing live-Pi contract test is gated on an env var, can separately validate the
  real devcontainer SearXNG instance without being part of the required default suite.
- **Alternatives considered**: Extending `FakeAgentSession` with `WEB_SEARCH_DIRECTIVE`/
  `WEB_FETCH_DIRECTIVE` scripting, mirroring `READ_DOCUMENT_DIRECTIVE` — rejected as unnecessary
  indirection for tools with no interaction with `EditService`/`ConflictService`/`PrimaryMutex`
  (the reason `propose_document_edit`'s directive exists); direct `.execute()` calls in
  unit/contract tests reach the same code with less scaffolding.

## R6: Configuration surface

- **Decision**: `RADR_BE_SEARXNG_URL` (optional, default `http://searxng:8080` — the devcontainer/
  production-compose service address), read in `config.ts` alongside the other `RADR_BE_*`
  variables (FR-011). Per-call timeout for both tools is a code constant, overridable via an
  unprefixed test-only env var (`WEB_TOOL_TIMEOUT_MS`) for fast test runs — mirroring the existing
  `PI_AGENT_TURN_TIMEOUT_MS`/`PI_FAKE_CHUNK_DELAY_MS` pattern, which are deliberately not
  `RADR_BE_`-prefixed because they are test/tuning knobs, not application-facing configuration.
- **Rationale**: Matches the existing `Config` shape and naming convention exactly (default + env
  override, `RADR_BE_` prefix only for genuinely operator-facing configuration).

## R7: What belongs in a shared `pi/tools/common.ts`, now that tools are split across files?

- **Decision**: Extract two small helpers used by every tool, not just the two new ones:
  - `textResult(text, details?)` — builds the `{content: [{type: 'text' as const, text}], details}`
    shape every `execute` in `read-document.ts`/`propose-document-edit.ts` already constructs
    inline today, several times each (e.g. the "no document available" branches, the clamp-note
    branch, the applied/staged branches).
  - `clampWithNote(...)` — generalizes `read-document.ts`'s existing inline clamp-and-note logic
    (used today only for `from_line`/`to_line` bounds) into a reusable shape, so `web_fetch`'s
    content-length truncation (FR-012, R4) reads as the same pattern rather than a second
    independent implementation of "clamp a value and say so in the result".
- **Rationale**: Splitting `document-tools.ts` into `pi/tools/*.ts` (per the colocation decision)
  is the natural point to also deduplicate the boilerplate that was previously invisible inside one
  file — four tool files independently reconstructing the same result-wrapper shape is exactly the
  kind of duplication a shared module should absorb, and doing it now avoids `web-search.ts`/
  `web-fetch.ts` copying that boilerplate a third and fourth time.
- **Alternatives considered**: Leaving each tool file to build its own result object inline (status
  quo in `document-tools.ts`) — rejected once there are four tool files instead of two, since the
  duplication becomes harder to keep consistent (e.g. a future change to the result shape would
  need updating in four places instead of one).
