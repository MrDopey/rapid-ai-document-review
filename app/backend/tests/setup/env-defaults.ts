// Runs before each test file's own imports (Vitest `setupFiles`). Several test files statically
// import `pi-service.ts` (and transitively `config.ts`) at module-evaluation time, before any
// `beforeEach` gets a chance to set env vars — since `RADR_BE_PI_AGENT_MODEL` is a required
// variable with no default, those files need a value present this early. Tests that care about
// unset/blank/override behavior (config.test.ts, pi-model-config.test.ts) still fully control this
// var themselves via `delete`/assignment in their own `beforeEach` before their dynamic re-imports.
process.env.RADR_BE_PI_AGENT_MODEL ??= 'anthropic/claude-opus-4-5';

// FakeAgentSession streams deltas with a real per-chunk delay by default (fake-agent-session.ts),
// to mirror a real model's incremental output — needed by Playwright e2e specs (e.g. us5.spec.ts's
// "act while active" step) that depend on a turn staying `streaming` for a measurable window.
// Vitest runs (unit/integration/contract) never assert on that window, only on the turn's final
// outcome — usually via `waitFor` polling — so collapsing the delay to 0 here makes every fake
// turn settle within a tick, with no behavior change, just faster tests. Playwright's own
// webServer `env` (playwright.config.ts) doesn't source this file, so e2e keeps the real delay.
process.env.PI_FAKE_CHUNK_DELAY_MS ??= '0';

// web_search/web_fetch's outbound HTTP timeout (pi/tools/common.ts) defaults to 8000ms in
// production; tests that exercise an unreachable/timing-out stub don't need to wait that long to
// prove the timeout fires, so this collapses it to keep the default suite fast.
process.env.WEB_TOOL_TIMEOUT_MS ??= '200';
