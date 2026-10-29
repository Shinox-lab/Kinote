import { assertEmbeddingDimensions, closeDb, initDb } from '@kinote/db';
import { createAnswerProvider, createEmbeddingProvider, EMBEDDING_DIMENSIONS } from '@kinote/core';
import { createObjectStorage, loadConfig } from '@kinote/shared';
import { buildApiServer } from './server.js';
import { HttpCollabClient } from '@kinote/shared';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = initDb({ url: config.DATABASE_URL });
  await assertEmbeddingDimensions(db, EMBEDDING_DIMENSIONS);

  const storage = createObjectStorage(config);
  await storage.ensureBucket();

  const embeddingProvider = createEmbeddingProvider(config);
  const answerProvider = createAnswerProvider(config);
  const app = buildApiServer({
    storage,
    embeddingProvider,
    answerProvider,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    authRateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
    collab: new HttpCollabClient(config.COLLAB_INTERNAL_URL, config.INTERNAL_SECRET),
  });
  await app.listen({ port: config.API_PORT, host: config.HOST });
  console.log(`api listening on ${config.HOST}:${config.API_PORT}`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      console.error('api shutdown failed:', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('api failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
