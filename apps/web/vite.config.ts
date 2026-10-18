import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'app',
  plugins: [
    // Force the automatic JSX runtime (React 18 react-jsx style). Relying on
    // tsconfig discovery bit us here: the classic transform emitted
    // React.createElement without React in scope.
    react({ jsxRuntime: 'automatic', jsxImportSource: 'react' }),
  ],
  server: {
    port: 5173,
    proxy: {
      // The API listens directly on 8787; browser code just calls /api/...
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  // Pre_bundle every entry-graph dependency upfront: without this, Vite
  // discovers heavy deps on first load, re-optimizes, and force-reloads,
  // which can leave the page blank if the snapshot lands mid-reload.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'yjs',
      'lib0',
      'y-protocols/awareness',
      '@hocuspocus/provider',
      '@blocknote/core',
      '@blocknote/react',
      '@blocknote/mantine',
    ],
    exclude: ['@living-wiki/contracts'],
  },
  resolve: {
    // Workspace packages publish bare TS sources (@living-wiki/contracts/main
    // -> src/index.ts); alias them explicitly so dev + build both resolve.
    alias: {
      '@living-wiki/contracts': path.resolve(here, '..', '..', 'packages', 'contracts', 'src', 'index.ts'),
    },
    dedupe: ['yjs', 'lib0', 'y-protocols', '@blocknote/core', '@hocuspocus/provider'],
  },
});
