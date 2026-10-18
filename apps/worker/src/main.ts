import { closeDb, initDb } from '@living-wiki/db';
import { defaultEmbeddingProvider } from '@living-wiki/core';
import { loadConfig } from '@living-wiki/shared';
import { runPendingJobsForTenant } from './runner.js';

// The runner processes one tenant at a time; discovering which tenants have
// due jobs needs the due-jobs function added in Task 2.3 and the loop is wired
// in Task 2.4. Referenced so the entry point stays type-checked against it.
export const runTenantJobs = runPendingJobsForTenant;

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = defaultEmbeddingProvider;
  if (provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding provider "${provider.model}" produces ${provider.dimensions}-dimension vectors ` +
        `but EMBEDDING_DIMENSIONS is ${config.EMBEDDING_DIMENSIONS}.`
    );
  }
  initDb({ url: config.DATABASE_URL });
  console.log('worker started; the job loop is wired in Task 2.4 (idle until then)');

  // Keep the process alive until SIGTERM.
  const keepAlive = setInterval(() => undefined, 60_000);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    try {
      await closeDb();
      process.exit(0);
    } catch (err) {
      console.error('worker shutdown failed:', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
