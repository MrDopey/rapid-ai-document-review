import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FR-044: loopback is the default access-control model; a non-default `HOST` is an explicit
 * operator opt-in that must be honored, but only alongside a visible, logged warning — never
 * silently. `config.ts` reads `process.env` exactly once, at module evaluation time (see
 * `tests/contract/test-app.ts`'s own note on this), so each case here sets `process.env.HOST`
 * before a fresh dynamic `import()`, guarded by `vi.resetModules()`.
 */
describe('HOST binding (FR-044)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.HOST;
    process.env.DATABASE_PATH ??= ':memory:';
    process.env.LOG_LEVEL ??= 'silent';
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults to 127.0.0.1 and logs no warning when HOST is unset', async () => {
    const { config, DEFAULT_HOST } = await import('../../src/config.js');
    const { logger, warnIfHostOverridden } = await import('../../src/logging.js');

    expect(config.host).toBe('127.0.0.1');
    expect(config.host).toBe(DEFAULT_HOST);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    warnIfHostOverridden();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('honors an explicit non-default HOST and logs a warning identifying the exposure', async () => {
    process.env.HOST = '0.0.0.0';
    const { config } = await import('../../src/config.js');
    const { logger, warnIfHostOverridden } = await import('../../src/logging.js');

    expect(config.host).toBe('0.0.0.0');

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    warnIfHostOverridden();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ host: '0.0.0.0' });
  });
});
