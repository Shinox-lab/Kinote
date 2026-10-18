import { closeDb, initDb } from '@living-wiki/db';
import { defaultEmbeddingProvider } from '@living-wiki/core';
import { loadConfig } from '@living-wiki/shared';
import { runWorkerLoop } from './runner.js';

const POLL_INTERVAL_MS = 1000;

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

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  console.log('[worker] started');
  try {
    await runWorkerLoop({
      intervalMs: POLL_INTERVAL_MS,
      signal: controller.signal,
      embeddingProvider: provider,
    });
  } finally {
    await closeDb();
  }
  console.log('[worker] stopped');
}

main().catch((err: unknown) => {
  console.error('worker failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
