import { closeDb, initDb } from '@living-wiki/db';
import { loadConfig } from '@living-wiki/shared';
import { buildApiServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  initDb({ url: config.DATABASE_URL });

  const app = buildApiServer({ trustProxy: config.TRUST_PROXY });
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
