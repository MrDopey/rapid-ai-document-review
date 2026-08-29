# Quickstart: RADR-Prefixed Environment Variables

Validates the rename end-to-end per spec.md's user stories. See
[contracts/environment-variable-mapping.md](./contracts/environment-variable-mapping.md) for the full
old→new mapping and [data-model.md](./data-model.md) for the per-variable detail.

## Prerequisites

- Repo checked out, dependencies installed (`npm install` at repo root).
- This rename has been implemented (config.ts, server.ts, vite.config.ts, playwright.config.ts,
  test-app.ts, live-pi.test.ts, docker-compose.yml, README.md all updated per the mapping table).

## Scenario 1 — Fresh deployment with new names behaves identically (User Story 1)

1. Start the backend using only new names:
   ```bash
   RADR_PORT=3000 RADR_HOST=127.0.0.1 RADR_DATABASE_PATH=./data/document-review.sqlite \
   RADR_PI_SESSION_STORAGE_PATH=./data/pi-sessions RADR_PI_CODING_AGENT_DIR=./data/pi-agent \
   RADR_LOG_LEVEL=info RADR_PI_FAKE_SESSIONS=1 npm run dev -w app/backend
   ```
2. Start the frontend with `RADR_BACKEND_PORT=3000 npm run dev -w app/frontend`.
3. **Expected**: identical startup and runtime behavior to today's equivalent unprefixed configuration —
   same port, same bind host, same data locations, same fake-session behavior.

## Scenario 2 — Old names no longer take effect (User Story 2, FR-002)

1. Start the backend with only an old name set, e.g. `PORT=4000` (no `RADR_PORT`).
2. **Expected**: the backend starts on the *default* port (`3000`), not `4000` — `PORT` is not read at
   all. Confirms the old name is inert, not silently honored.

## Scenario 3 — Full automated test suite passes under new names (SC-002)

```bash
npm run test:unit -w app/backend
npm run test:contract -w app/backend
npm run test:e2e   # via playwright.config.ts, now setting only RADR_-prefixed vars
```

**Expected**: all suites pass exactly as before the rename — `playwright.config.ts`,
`app/backend/tests/contract/test-app.ts`, and `live-pi.test.ts` now set/read only `RADR_`-prefixed
names internally.

## Scenario 4 — Docker deployment uses new names

1. Inspect `docker/docker-compose.yml`: confirm every `environment:` entry for the `app` service uses a
   `RADR_`-prefixed key.
2. `docker compose -f docker/docker-compose.yml up` (or equivalent) and confirm the container starts and
   serves the application exactly as before.

## Scenario 5 — Documentation gives the old→new mapping (SC-003)

1. Open `README.md`'s configuration section.
2. **Expected**: every variable name shown is `RADR_`-prefixed, `ANTHROPIC_API_KEY` is called out as an
   explicit exception, and a mapping table (or equivalent) lets an upgrading operator find every old name's
   new equivalent in under 2 minutes without reading source code.

## Out of scope for this quickstart

- No scenario for `ANTHROPIC_API_KEY` or `NODE_ENV` — unaffected by this feature (contracts/
  environment-variable-mapping.md's "Unchanged" table).
