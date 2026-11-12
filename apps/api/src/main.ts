import { assertEmbeddingDimensions, closeDb, initDb, readModelSettings } from '@kinote/db';
import { EMBEDDING_DIMENSIONS, modelFactoriesFrom, ModelProviders, ModelSettingsCache } from '@kinote/core';
import { createObjectStorage, loadConfig, usageLimitsOf } from '@kinote/shared';
import { buildApiServer } from './server.js';
import { createSmtpMailer } from './mail.js';
import { HttpCollabClient } from '@kinote/shared';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = initDb({ url: config.DATABASE_URL });
  await assertEmbeddingDimensions(db, EMBEDDING_DIMENSIONS);

  const storage = createObjectStorage(config);
  await storage.ensureBucket();

  const mailer = config.SMTP_URL
    ? createSmtpMailer({ smtpUrl: config.SMTP_URL, from: config.MAIL_FROM!, publicUrl: config.PUBLIC_URL! })
    : undefined;
  if (!mailer && config.SIGNUP_MODE === 'open') {
    console.warn('api: SIGNUP_MODE=open without SMTP_URL: anyone can sign up with any email address, unverified');
  }

  // Models and rates: the control plane's stored settings, each falling back to the env.
  const modelCache = new ModelSettingsCache(() => readModelSettings(db), config);
  await modelCache.refresh();
  const stopModelRefresh = modelCache.start();
  const models = new ModelProviders(modelCache, modelFactoriesFrom(config));
  const app = buildApiServer({
    storage,
    models,
    billingUrl: config.BILLING_URL,
    controlPlaneTokens: config.CONTROL_PLANE_TOKENS,
    controlPlaneAllowedIps: config.CONTROL_PLANE_ALLOWED_IPS,
    ...(config.KINOTE_VERSION ? { kinoteVersion: config.KINOTE_VERSION } : {}),
    ...(config.PUBLIC_URL ? { publicUrl: config.PUBLIC_URL } : {}),
    ...(config.KINOTE_DEPLOY_ID ? { deployId: config.KINOTE_DEPLOY_ID } : {}),
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    maxConcurrentUploads: config.MAX_CONCURRENT_UPLOADS,
    ...(config.UPLOAD_TMP_DIR ? { uploadTmpDir: config.UPLOAD_TMP_DIR } : {}),
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    authRateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
    limits: usageLimitsOf(config),
    signUpMode: config.SIGNUP_MODE,
    ...(mailer ? { mailer } : {}),
    collab: new HttpCollabClient(config.COLLAB_INTERNAL_URL, config.INTERNAL_SECRET),
  });
  await app.listen({ port: config.API_PORT, host: config.HOST });
  console.log(`api listening on ${config.HOST}:${config.API_PORT}`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      stopModelRefresh();
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
