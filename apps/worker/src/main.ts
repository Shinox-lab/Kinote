import { assertEmbeddingDimensions, closeDb, initDb, readModelSettings } from '@kinote/db';
import { createExtractor, EMBEDDING_DIMENSIONS, modelFactoriesFrom, ModelProviders, ModelSettingsCache } from '@kinote/core';
import { HttpCollabClient, createObjectStorage, loadConfig, routerProviderProblem } from '@kinote/shared';
import { runWorkerLoop } from './runner.js';

const POLL_INTERVAL_MS = 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const routerProblem = routerProviderProblem(config);
  if (routerProblem) throw new Error(routerProblem);
  const db = initDb({ url: config.DATABASE_URL });
  await assertEmbeddingDimensions(db, EMBEDDING_DIMENSIONS);
  // Models and rates: the control plane's stored settings, each falling back to the env.
  const modelCache = new ModelSettingsCache(() => readModelSettings(db), config);
  await modelCache.refresh();
  const stopModelRefresh = modelCache.start();
  const models = new ModelProviders(modelCache, modelFactoriesFrom(config));
  const provider = models.embedding();
  if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding provider "${provider.model}" produces ${provider.dimensions}-dimension vectors ` +
        `but the index is halfvec(${EMBEDDING_DIMENSIONS}).`
    );
  }
  const storage = createObjectStorage(config);
  await storage.ensureBucket();
  const extractor = createExtractor(config);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  console.log(`[worker] started (router: ${config.ROUTER_PROVIDER} ${modelCache.current().routerModel ?? ''})`.trimEnd());
  try {
    await runWorkerLoop({
      intervalMs: POLL_INTERVAL_MS,
      signal: controller.signal,
      embeddingProvider: provider,
      storage,
      extractor,
      maxExtractedChars: config.MAX_EXTRACTED_CHARS,
      placementModel: models.routing(),
      collab: new HttpCollabClient(config.COLLAB_INTERNAL_URL, config.INTERNAL_SECRET),
      aiDailyLimit: config.TENANT_DAILY_AI_ACTIONS,
      creditRates: modelCache.current().creditRates,
    });
  } finally {
    stopModelRefresh();
    await closeDb();
  }
  console.log('[worker] stopped');
}

main().catch((err: unknown) => {
  console.error('worker failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
