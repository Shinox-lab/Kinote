import { assertEmbeddingDimensions, closeDb, initDb } from '@living-wiki/db';
import { createEmbeddingProvider, createExtractor, EMBEDDING_DIMENSIONS } from '@living-wiki/core';
import { createObjectStorage, loadConfig } from '@living-wiki/shared';
import { runWorkerLoop } from './runner.js';

const POLL_INTERVAL_MS = 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createEmbeddingProvider(config);
  if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding provider "${provider.model}" produces ${provider.dimensions}-dimension vectors ` +
        `but the index is halfvec(${EMBEDDING_DIMENSIONS}).`
    );
  }
  const db = initDb({ url: config.DATABASE_URL });
  await assertEmbeddingDimensions(db, EMBEDDING_DIMENSIONS);
  const storage = createObjectStorage(config);
  await storage.ensureBucket();
  const extractor = createExtractor(config);

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
      storage,
      extractor,
      maxExtractedChars: config.MAX_EXTRACTED_CHARS,
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
