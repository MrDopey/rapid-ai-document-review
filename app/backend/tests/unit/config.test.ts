import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FR-044: loopback is the default access-control model; a non-default `RADR_BE_HOST` is an explicit
 * operator opt-in that must be honored, but only alongside a visible, logged warning — never
 * silently. `config.ts` reads `process.env` exactly once, at module evaluation time (see
 * `tests/contract/test-app.ts`'s own note on this), so each case here sets `process.env.RADR_BE_HOST`
 * before a fresh dynamic `import()`, guarded by `vi.resetModules()`.
 */
describe('RADR_BE_HOST binding (FR-044)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RADR_BE_HOST;
    process.env.RADR_BE_DATABASE_PATH ??= ':memory:';
    process.env.RADR_BE_LOG_LEVEL ??= 'silent';
    process.env.RADR_BE_PI_AGENT_MODEL ??= 'anthropic/claude-opus-4-5';
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to 127.0.0.1 and logs no warning when RADR_BE_HOST is unset', async () => {
    const { config, DEFAULT_HOST } = await import('../../src/config.js');
    const { logger, warnIfHostOverridden } = await import('../../src/logging.js');

    expect(config.host).toBe('127.0.0.1');
    expect(config.host).toBe(DEFAULT_HOST);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    warnIfHostOverridden();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('honors an explicit non-default RADR_BE_HOST and logs a warning identifying the exposure', async () => {
    process.env.RADR_BE_HOST = '0.0.0.0';
    const { config } = await import('../../src/config.js');
    const { logger, warnIfHostOverridden } = await import('../../src/logging.js');

    expect(config.host).toBe('0.0.0.0');

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    warnIfHostOverridden();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ host: '0.0.0.0' });
  });
});

/**
 * `RADR_BE_PI_AGENT_MODEL` is a required variable, read once at module-evaluation time into
 * `Config.piAgentModel`. Unset, empty, or whitespace-only values are all invalid — `config.ts`
 * throws rather than falling back to any default. A non-blank value is passed through
 * raw/unparsed — `config.ts` does not split or validate the `provider/model[:thinkingLevel]`
 * shape; that happens elsewhere (`pi-service.ts`'s `ModelRuntime` resolution), out of scope for
 * this module.
 */
describe('RADR_BE_PI_AGENT_MODEL parsing (mandatory)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RADR_BE_PI_AGENT_MODEL;
    process.env.RADR_BE_DATABASE_PATH ??= ':memory:';
    process.env.RADR_BE_LOG_LEVEL ??= 'silent';
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('throws when RADR_BE_PI_AGENT_MODEL is unset', async () => {
    await expect(import('../../src/config.js')).rejects.toThrow(/RADR_BE_PI_AGENT_MODEL/);
  });

  it('throws when RADR_BE_PI_AGENT_MODEL is an empty string', async () => {
    process.env.RADR_BE_PI_AGENT_MODEL = '';

    await expect(import('../../src/config.js')).rejects.toThrow(/RADR_BE_PI_AGENT_MODEL/);
  });

  it('throws when RADR_BE_PI_AGENT_MODEL is whitespace-only', async () => {
    process.env.RADR_BE_PI_AGENT_MODEL = '   ';

    await expect(import('../../src/config.js')).rejects.toThrow(/RADR_BE_PI_AGENT_MODEL/);
  });

  it('passes through a non-blank RADR_BE_PI_AGENT_MODEL value raw/unparsed', async () => {
    process.env.RADR_BE_PI_AGENT_MODEL = 'anthropic/claude-opus-4-5';
    const { config } = await import('../../src/config.js');

    expect(config.piAgentModel).toBe('anthropic/claude-opus-4-5');
  });
});
