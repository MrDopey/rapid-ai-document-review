import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Logger } from '../../logging.ts';

// Resolved from this module's compiled location, not process.cwd(), so it works regardless of
// where the server is started from.
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

// Skips gracefully if `dist/public` is missing (e.g. a local build that only built the backend) —
// startup shouldn't crash just because the frontend wasn't bundled.
export function registerStaticRoutes(
  app: FastifyInstance,
  deps: { logger: Logger; dir?: string },
): void {
  const dir = deps.dir ?? publicDir;

  if (!existsSync(dir)) {
    deps.logger.warn(
      { dir },
      'static assets directory not found — skipping frontend static-file serving (expected in local dev when only the backend is built; docker/Dockerfile populates this directory in the production image)',
    );
    return;
  }

  app.register(fastifyStatic, { root: dir });

  app.setNotFoundHandler((request, reply) => {
    if (
      request.method !== 'GET' ||
      request.url.startsWith('/api/') ||
      request.url === '/events' ||
      request.url === '/healthz'
    ) {
      reply.code(404).send({ error: 'NOT_FOUND' });
      return;
    }
    reply.type('text/html').sendFile('index.html', dir);
  });
}
