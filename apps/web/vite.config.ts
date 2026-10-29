import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { devTargets } from './dev-targets.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Excalidraw's own font files (`dist/prod/fonts` beside its entry). */
const excalidrawFonts = path.join(path.dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw')), 'fonts');

/**
 * Serves Excalidraw's fonts at /excalidraw-assets/fonts in dev and copies them
 * there in the build, so drawings never fetch fonts from a CDN
 * (window.EXCALIDRAW_ASSET_PATH points at /excalidraw-assets/).
 */
function excalidrawAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'kinote-excalidraw-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw-assets/fonts', (req, res, next) => {
        const file = path.join(excalidrawFonts, decodeURIComponent((req.url ?? '').split('?')[0]!));
        if (!file.startsWith(excalidrawFonts) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(excalidrawFonts, path.join(outDir, 'excalidraw-assets', 'fonts'), { recursive: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  // The repo's .env (read here without a prefix filter) says which host ports the stack
  // published; the shell environment still wins. See dev-targets.ts.
  const { apiUrl, collabUrl, gridcraftUrl } = devTargets({
    ...loadEnv(mode, path.resolve(here, '..', '..'), ''),
    ...process.env,
  });

  return {
    plugins: [react(), tailwindcss(), excalidrawAssets()],
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
        '@kinote/contracts': path.resolve(here, '..', '..', 'packages', 'contracts', 'src', 'index.ts'),
      },
      dedupe: ['react', 'react-dom', 'yjs', 'lib0', 'y-protocols', '@blocknote/core', '@hocuspocus/provider'],
    },
  };
});
