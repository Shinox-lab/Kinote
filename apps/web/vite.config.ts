import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { devTargets } from './dev-targets.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // The repo's .env (read here without a prefix filter) says which host ports the stack
  // published; the shell environment still wins. See dev-targets.ts.
  const { apiUrl, collabUrl, gridcraftUrl } = devTargets({
    ...loadEnv(mode, path.resolve(here, '..', '..'), ''),
    ...process.env,
  });

  return {
    plugins: [react(), tailwindcss()],
    // The xlsx viewer creates its worker with new Worker(new URL(...), { type: 'module' }).
    // Vite's default iife worker output cannot code-split the package, and prebundling
    // rewrites the worker URL to a missing .vite/deps file in dev.
    worker: { format: 'es' },
    optimizeDeps: {
      exclude: ['@extend-ai/react-xlsx', '@dukelib/sheets-wasm'],
    },
    server: {
      port: 5173,
      // Same origin in dev: the console calls /api/... and /mcp/... on its own origin.
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true },
        '/mcp': { target: apiUrl, changeOrigin: true },
        // The live-editing websocket (collab server), same origin too: /collab is stripped before forwarding.
        '/collab': { target: collabUrl, ws: true, changeOrigin: true, rewrite: (p) => p.replace(/^\/collab/, '') },
        // The GridCraft static editor, same origin too: /gridcraft is stripped before forwarding.
        '/gridcraft': { target: gridcraftUrl, changeOrigin: true, rewrite: (p) => p.replace(/^\/gridcraft/, '') },
      },
    },
    resolve: {
      // Workspace packages publish bare TS sources; alias them so dev and build both resolve.
      alias: {
        '@living-wiki/contracts': path.resolve(here, '..', '..', 'packages', 'contracts', 'src', 'index.ts'),
      },
      dedupe: ['react', 'react-dom', 'yjs', 'lib0', 'y-protocols', '@blocknote/core', '@hocuspocus/provider'],
    },
  };
});
