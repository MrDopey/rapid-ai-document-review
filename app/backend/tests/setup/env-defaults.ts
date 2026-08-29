// Runs before each test file's own imports (Vitest `setupFiles`). Several test files statically
// import `pi-service.ts` (and transitively `config.ts`) at module-evaluation time, before any
// `beforeEach` gets a chance to set env vars — since `RADR_BE_PI_AGENT_MODEL` is a required
// variable with no default, those files need a value present this early. Tests that care about
// unset/blank/override behavior (config.test.ts, pi-model-config.test.ts) still fully control this
// var themselves via `delete`/assignment in their own `beforeEach` before their dynamic re-imports.
process.env.RADR_BE_PI_AGENT_MODEL ??= 'anthropic/claude-opus-4-5';
