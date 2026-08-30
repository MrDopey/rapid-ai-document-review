import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

const backendTarget = `http://127.0.0.1:${process.env.RADR_FE_BACKEND_PORT ?? '3000'}`;

// FR-044 (backend spec, applied here for consistency): loopback is the default, supported dev
// bind host. `RADR_FE_HOST` lets an operator explicitly opt into a wider bind (e.g. a
// containerized dev environment reached via port-forwarding) without changing that default.
// `allowedHosts` only needs to be relaxed together with a non-default host — Vite's own
// same-origin-by-default protection is otherwise appropriate for loopback-only dev use.
const frontendHost = process.env.RADR_FE_HOST ?? '127.0.0.1';
if (frontendHost !== '127.0.0.1') {
  console.warn(
    `[vite] binding beyond the loopback interface (host=${frontendHost}) — this dev server has no authentication; confirm this was an explicit, intended override (FR-044)`,
  );
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
  server: {
    host: frontendHost,
    port: 3001,
    allowedHosts: frontendHost === '127.0.0.1' ? undefined : true,
    proxy: {
      '/api': backendTarget,
      '/events': { target: backendTarget, ws: true },
    },
  },
});
