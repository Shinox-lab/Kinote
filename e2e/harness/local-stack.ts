// Local e2e stack without Docker (`pnpm e2e:local`, started by playwright.config.ts):
// the api, the collab server and the worker in ONE Node process on an in-memory PGlite
// database with deterministic embeddings, and the web console (a production build,
// served by `vite preview`) proxying to them. It is run directly with
//   node --import tsx e2e/harness/local-stack.ts
// and prints `READY <web url>` once everything accepts connections.
//
// Ports and timings come from the environment; the defaults avoid the compose
// stack's 8787 and 1234 (and vite's 5173):
//   E2E_API_PORT=18787  E2E_COLLAB_PORT=11234  E2E_WEB_PORT=15173
//   E2E_WORKER_POLL_MS=250        worker poll interval (the worker's own default is 1000)
//   E2E_COLLAB_DEBOUNCE_MS=300    collab store debounce (default 1000)
//   E2E_COLLAB_MAX_DEBOUNCE_MS=1000
// The quiet window of a space (120 s by default) is a space setting, not a service
// one: the specs submit explicitly, and a spec that needs the quiet snapshot sets the
// space's `quiet_seconds` (at least 10) through the API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createLogger, preview, type PreviewServer } from 'vite';
import { assertEmbeddingDimensions, closeDb } from '@living-wiki/db';
import { createTestDb } from '@living-wiki/db/testing';
import { EMBEDDING_DIMENSIONS, FakeExtractor, defaultEmbeddingProvider } from '@living-wiki/core';
import { InMemoryObjectStorage, loadConfig } from '@living-wiki/shared';
import { buildApiServer } from '../../apps/api/src/server.js';
import { HttpCollabClient } from '@living-wiki/shared';
import { collabSettle, createCollabServer } from '../../apps/collab/src/server.js';
import { runWorkerLoop } from '../../apps/worker/src/runner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = '127.0.0.1';

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error(`${name} must be a port number`);
  return value;
}

function millis(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds`);
  return value;
}

const apiPort = port('E2E_API_PORT', 18787);
const collabPort = port('E2E_COLLAB_PORT', 11234);
const webPort = port('E2E_WEB_PORT', 15173);

// The secrets only live as long as this process.
process.env.COLLAB_TOKEN_SECRET ??= 'e2e-collab-token-secret-0123456789abcdef';
const internalSecret = process.env.INTERNAL_SECRET ?? 'e2e-internal-secret-0123456789abcdef0123456789';
// Honours EMBEDDING_PROVIDER exactly like the services; the index width is fixed.
const config = loadConfig({
  ...process.env,
  DATABASE_URL: 'pglite',
  INTERNAL_SECRET: internalSecret,
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? 'deterministic',
});
if (defaultEmbeddingProvider.dimensions !== EMBEDDING_DIMENSIONS) {
  throw new Error(
    `Embedding provider "${defaultEmbeddingProvider.model}" produces ${defaultEmbeddingProvider.dimensions}-dimension ` +
      `vectors but the index is halfvec(${EMBEDDING_DIMENSIONS}).`
  );
}

const { db } = await createTestDb();
await assertEmbeddingDimensions(db, EMBEDDING_DIMENSIONS);

const collab = createCollabServer({
  collabTokenSecret: process.env.COLLAB_TOKEN_SECRET,
  internalSecret,
  debounceMs: millis('E2E_COLLAB_DEBOUNCE_MS', 300),
  maxDebounceMs: millis('E2E_COLLAB_MAX_DEBOUNCE_MS', 1000),
});
await collab.server.listen(collabPort);

// Files: one in-memory store shared by the api and the worker, and the fake extractor, which reads
// the text a test file carries (a first line FAKE-EXTRACT; see FakeExtractor). No MinIO, no Docling.
const storage = new InMemoryObjectStorage();
const extractor = new FakeExtractor();

const app = buildApiServer({
  storage,
  maxUploadBytes: config.MAX_UPLOAD_BYTES,
  // Every spec signs accounts up from this one address.
  authRateLimit: { max: 10_000, timeWindow: '1 minute' },
  collab: new HttpCollabClient(`http://${HOST}:${collabPort}`, internalSecret),
});
await app.listen({ port: apiPort, host: HOST });

const stopWorker = new AbortController();
const worker = runWorkerLoop({
  intervalMs: millis('E2E_WORKER_POLL_MS', 250),
  signal: stopWorker.signal,
  embeddingProvider: defaultEmbeddingProvider,
  storage,
  extractor,
  maxExtractedChars: config.MAX_EXTRACTED_CHARS,
  // Routed captures change live pages through collab, as the api's restore does.
  collab: new HttpCollabClient(`http://${HOST}:${collabPort}`, internalSecret),
});

// The console, built fresh so the specs run against the production bundle; vite.config.ts
// reads API_URL and COLLAB_URL for its proxy when it loads.
process.env.API_URL = `http://${HOST}:${apiPort}`;
process.env.COLLAB_URL = `http://${HOST}:${collabPort}`;
const webRoot = path.join(root, 'apps', 'web');
const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'living-wiki-e2e-web-'));
await build({
  root: webRoot,
  logLevel: 'error',
  build: { outDir: webDist, emptyOutDir: true },
});
// A browser that closes its tab resets the proxied websocket: vite logs that as an error, but it is routine.
const logger = createLogger('warn');
const logError = logger.error;
logger.error = (msg, options) => {
  if (!msg.includes('ws proxy')) logError(msg, options);
};
const web: PreviewServer = await preview({
  root: webRoot,
  customLogger: logger,
  logLevel: 'warn',
  build: { outDir: webDist },
  preview: { host: HOST, port: webPort, strictPort: true },
});

// On every way out, including an exit another library forces on SIGTERM.
process.on('exit', () => fs.rmSync(webDist, { recursive: true, force: true }));

let stopping = false;
async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  const step = async (label: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (err) {
      console.error(`[e2e] stopping ${label} failed:`, err instanceof Error ? err.message : err);
    }
  };
  await step('web', () => web.close());
  stopWorker.abort();
  await step('worker', () => worker);
  await step('api', () => app.close());
  await step('collab', () => collab.server.destroy());
  await step('collab bookkeeping', () => collabSettle(collab));
  await step('database', () => closeDb());
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[e2e] unhandled rejection (still running):', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});

console.log(`READY http://${HOST}:${webPort} (api ${apiPort}, collab ${collabPort})`);
