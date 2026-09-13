# Quickstart: SearXNG Web Search and Page Fetch for the Review Agent

Validates the feature end-to-end per spec.md's user stories. See [data-model.md](./data-model.md)
for the tool parameter/result shapes and [contracts/web-tools.md](./contracts/web-tools.md) for the
full tool contract.

## Prerequisites

- Repo checked out, dependencies installed (`npm install` at repo root).
- Devcontainer rebuilt after this feature lands (picks up the new `docker-compose.yml`/
  `searxng` service).

## Scenario 1 — Devcontainer provides a working search backend with zero setup (User Story 2)

1. Rebuild/reopen the devcontainer.
2. From inside the container, without any manual setup step:
   ```bash
   curl -s "http://searxng:8080/search?q=test&format=json" | head -c 300
   ```
3. **Expected**: a JSON response body (not a 403 or connection error) — confirms the `searxng`
   service is up and its JSON output format is enabled (research.md R1/R2).

## Scenario 2 — Agent uses `web_search` to ground an answer (User Story 1)

1. Start the backend against the devcontainer's SearXNG instance:
   ```bash
   RADR_BE_PI_AGENT_MODEL=<provider/model> ANTHROPIC_API_KEY=<key> npm run dev -w app/backend
   ```
   (`RADR_BE_SEARXNG_URL` defaults to `http://searxng:8080`, matching the compose service — no
   override needed inside the devcontainer.)
2. Create a conversation and ask the agent a question whose answer depends on current web
   information.
3. **Expected**: the conversation transcript shows a `web_search` tool activity (query + result
   summary), and the agent's reply reflects information plausibly drawn from the results
   (contracts/web-tools.md contract test 1).

## Scenario 3 — Agent uses `web_fetch` for full page content (User Story 1)

1. In the same conversation, ask a follow-up that needs more detail than a search snippet gives.
2. **Expected**: a `web_fetch` tool activity appears for a URL from the prior search results, and
   the agent's reply draws on the fetched page's content (contracts/web-tools.md contract test 5).

## Scenario 4 — Search backend down does not break the conversation (edge case, FR-009/SC-004)

1. Stop the `searxng` service (`docker compose stop searxng` from `.devcontainer/`).
2. Ask the agent a question that would trigger a search.
3. **Expected**: the agent receives an explanatory tool error and continues the conversation
   normally — chat and `read_document` remain unaffected (contracts/web-tools.md contract test 3).
   Restart `searxng` afterward.

## Scenario 5 — Fake-session mode unaffected

1. Start the backend with `RADR_BE_PI_FAKE_SESSIONS=1` (no model credential needed).
2. Confirm `web_search`/`web_fetch` appear in `getActiveToolNames()` for a new conversation
   (e.g. via a contract test or a debug log), even though `FakeAgentSession` never invokes them
   without a scripted directive.
3. **Expected**: no change to existing fake-session behavior — both tools are simply present but
   inert unless a test explicitly calls them (research.md R5).

## Scenario 6 — Default test suite needs no live SearXNG instance

1. Run `npm run test:unit && npm run test:contract` with no `searxng` service running and no
   internet access.
2. **Expected**: all `web_search`/`web_fetch` tests pass against the local HTTP stub
   (research.md R5) — none fail or skip due to the absence of a live backend.
