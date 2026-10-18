import { closeDb, initDb } from '@living-wiki/db';
import { loadConfig } from '@living-wiki/shared';
import { createCollabServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  initDb({ url: config.DATABASE_URL });

  const collab = createCollabServer({
    collabTokenSecret: config.COLLAB_TOKEN_SECRET,
    internalSecret: config.INTERNAL_SECRET,
  });
  await collab.server.listen(config.COLLAB_PORT);
  console.log(`collab listening on port ${config.COLLAB_PORT}`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      // Closes connections and flushes pending stores before the pool closes.
      await collab.server.destroy();
      await closeDb();
      process.exit(0);
    } catch (err) {
      console.error('collab shutdown failed:', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('collab failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
