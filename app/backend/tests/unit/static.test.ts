import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerStaticRoutes } from '../../src/api/http/static.ts';
import { logger } from '../../src/logging.ts';

/**
 * Exercises `registerStaticRoutes` directly against a bare Fastify instance (rather than the full
 * `buildApp()` graph, which has no reason to depend on any of this) with a throwaway directory
 * standing in for the real `dist/public` (docker/Dockerfile's copied frontend build) — see
 * static.ts's doc comment for why that real directory only exists in a production image, never in
 * this repo's own checkout.
 */
describe('registerStaticRoutes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'radr-static-test-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app shell</body></html>');
    writeFileSync(join(dir, 'app.js'), 'console.log("hi");');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a real static asset by exact path', async () => {
    const app = Fastify();
    registerStaticRoutes(app, { logger, dir });

    const res = await app.inject({ method: 'GET', url: '/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log("hi");');
  });

  it('serves index.html at the root', async () => {
    const app = Fastify();
    registerStaticRoutes(app, { logger, dir });

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('app shell');
  });

  it('falls back to index.html for an unmatched client-side route (SPA fallback)', async () => {
    const app = Fastify();
    registerStaticRoutes(app, { logger, dir });

    const res = await app.inject({ method: 'GET', url: '/some-nonexistent-spa-route' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('app shell');
  });

  it('does not shadow /api/* with the SPA fallback', async () => {
    const app = Fastify();
    registerStaticRoutes(app, { logger, dir });

    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('does not shadow /events with the SPA fallback', async () => {
    const app = Fastify();
    registerStaticRoutes(app, { logger, dir });

    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('does not shadow /healthz with the SPA fallback', async () => {
    const app = Fastify();
    registerStaticRoutes(app, { logger, dir });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND' });
  });

  it('skips registration without crashing when the directory does not exist', async () => {
    const app = Fastify();
    registerStaticRoutes(app, { logger, dir: join(dir, 'does-not-exist') });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/' });
    // Fastify's own default 404 — registerStaticRoutes installed no notFoundHandler at all here.
    expect(res.statusCode).toBe(404);
  });
});
