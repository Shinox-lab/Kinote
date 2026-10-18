#!/usr/bin/env node
// Dev entrypoint: boots the API HTTP server, the collab WebSocket server and an
// in-process worker loop, all against the shared in-memory PGlite database.
//
// Runs from dist/ (built TS) so it mirrors a production layout. The database
// lives in PGlite's memory: it starts empty on every boot and is initialized
// with migrations below, so data resets whenever this process restarts.
//
// Ports: API_PORT (default 8787), COLLAB_PORT (default 1234), HOST (default 127.0.0.1).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const dist = path.join(root, 'dist');
const distUrl = (rel) => pathToFileURL(path.join(dist, rel)).href;

if (!existsSync(path.join(dist, 'apps/api/src/server.js'))) {
  console.error('dist/ is missing — run `pnpm run dev` (builds first) or `pnpm run build`.');
  process.exit(1);
}

const HOST = process.env.HOST || '127.0.0.1';
const API_PORT = Number(process.env.API_PORT || 8787);
const COLLAB_PORT = Number(process.env.COLLAB_PORT || 1234);
const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 2000);

const { buildApiServer } = await import(distUrl('apps/api/src/server.js'));
const { collabServer } = await import(distUrl('apps/collab/src/server.js'));
const { createTestDb } = await import(distUrl('packages/db/src/testing.js'));
const { runPendingJobsForTenant } = await import(distUrl('apps/worker/src/runner.js'));

// ---- Database ---------------------------------------------------------------
// The in-memory DB is empty on boot; createTestDb() creates it, applies the
// migration chain and assumes the app role. (Replaced by the real service
// entry points in Task 2.6.)
const { pglite } = await createTestDb();

// ---- Worker loop ------------------------------------------------------------
// Jobs are RLS-protected, so discovering queued work across tenants needs the
// session superuser. We keep that window to a single SELECT (dev-only trick);
// actual per-tenant job processing always runs under RLS with the tenant
// context set per transaction.
let polling = false;

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    await pglite.exec('RESET ROLE;');
    let rows = [];
    try {
      const result = await pglite.exec(
        "SELECT DISTINCT tenant_id FROM jobs WHERE status = 'queued' AND run_at <= now();"
      );
      rows = result[0].rows; // exec() returns one result per statement
    } finally {
      await pglite.exec('SET ROLE living_wiki_app;');
    }
    for (const row of rows) {
      try {
        const processed = await runPendingJobsForTenant(row.tenant_id, { now: new Date() });
        if (processed.length > 0) {
          console.log(
            `[worker] tenant ${row.tenant_id.slice(0, 8)}: processed ${processed.length} job(s) → ${processed
              .map((j) => `${j.queue}:${j.status}`)
              .join(', ')}`
          );
        }
      } catch (err) {
        console.error(`[worker] tenant ${row.tenant_id.slice(0, 8)} failed:`, err);
      }
    }
  } catch (err) {
    console.error('[worker] poll failed:', err);
  } finally {
    polling = false;
  }
}

const workerTimer = setInterval(pollOnce, WORKER_INTERVAL_MS);
workerTimer.unref?.();

// ---- Web app (Vite dev server) ----------------------------------------------
// Serves a live BlockNote editor wired to the API and the collab WS. Optional:
// skipped when the web app folder is not present.
let webChild = null;
const webDir = path.join(root, 'apps/web');
const viteBin = path.join(root, 'node_modules', '.bin', 'vite');
const viteLoader = existsSync(viteBin) && existsSync(path.join(webDir, 'vite.config.ts'));

if (viteLoader) {
  webChild = spawn(viteBin, [], {
    cwd: webDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (src) => {
    src.setEncoding('utf8');
    src.on('data', (chunk) => {
      for (const line of chunk.split('\n').filter(Boolean)) console.log(`[web] ${line}`);
    });
  };
  pipe(webChild.stdout);
  pipe(webChild.stderr);
  webChild.on('exit', (code) => {
    webChild = null;
    if (code !== 0 && code !== null) console.error(`[web] vite exited with code ${code}`);
  });
} else {
  console.log('[living-wiki] web app not found — backend only (apps/web missing vite config)');
}
// ---- Servers ----------------------------------------------------------------
const api = buildApiServer();
await api.listen({ port: API_PORT, host: HOST });
await collabServer.listen(COLLAB_PORT);

console.log(`[living-wiki] API      http://${HOST}:${API_PORT}`);
console.log(`[living-wiki] Collab   ws://${HOST}:${COLLAB_PORT}`);
console.log(`[living-wiki] Worker   polling every ${WORKER_INTERVAL_MS}ms (in-memory DB: data resets on restart)`);
if (webChild) console.log(`[living-wiki] Web      http://localhost:5173/editor (BlockNote editor, via Vite)`);
console.log('[living-wiki] Try:');
console.log(
  `  curl -s -X POST http://${HOST}:${API_PORT}/api/v1/tenants -H 'content-type: application/json' -d '{"name":"Docs","slug":"docs","owner_email":"owner@example.com","owner_name":"Owner"}'`
);

// ---- Shutdown ---------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[living-wiki] ${signal} — shutting down…`);
  clearInterval(workerTimer);
  if (webChild) webChild.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
  await Promise.allSettled([api.close(), collabServer.destroy()]);
  if (webChild) await new Promise((r) => webChild.once('exit', r));
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[living-wiki] unhandled rejection:', err));
