import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const backendTarget = `http://127.0.0.1:${process.env.BACKEND_PORT ?? '3000'}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 3001,
    allowedHosts: true,
    proxy: {
      '/api': backendTarget,
      '/events': { target: backendTarget, ws: true },
    },
  },
});
