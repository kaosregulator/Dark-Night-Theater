import { defineConfig } from 'vite';

// The Discord Activity frontend lives in ./client and is built into ./dist/public,
// which the Express server serves in production. In dev, Vite runs on 5173 and
// proxies /api and /ws to the backend (default :3000).
export default defineConfig({
  root: 'client',
  base: '/',
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
