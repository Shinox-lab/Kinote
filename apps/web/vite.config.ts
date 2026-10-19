import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

// The API's default port (API_PORT in packages/shared/src/config.ts).
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';

// The collab server's default port (COLLAB_PORT in packages/shared/src/config.ts).
const COLLAB_URL = process.env.COLLAB_URL ?? 'http://127.0.0.1:1234';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same origin in dev: the console calls /api/... and /mcp/... on its own origin.
    proxy: {
      '/api': { target: API_URL, changeOrigin: true },
      '/mcp': { target: API_URL, changeOrigin: true },
      // The live-editing websocket (collab server), same origin too: /collab is stripped before forwarding.
      '/collab': { target: COLLAB_URL, ws: true, changeOrigin: true, rewrite: (p) => p.replace(/^\/collab/, '') },
    },
  },
  resolve: {
    // Workspace packages publish bare TS sources; alias them so dev and build both resolve.
    alias: {
      '@living-wiki/contracts': path.resolve(here, '..', '..', 'packages', 'contracts', 'src', 'index.ts'),
    },
    dedupe: ['react', 'react-dom', 'yjs', 'lib0', 'y-protocols', '@blocknote/core', '@hocuspocus/provider'],
  },
});
