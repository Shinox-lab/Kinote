import { closeDb, initDb } from '@living-wiki/db';
import { loadConfig } from '@living-wiki/shared';
import { collabSettle, createCollabServer } from './server.js';

/** Longest shutdown waits for in-flight change bookkeeping before the pool closes. */
const SETTLE_TIMEOUT_MS = 5_000;
/** Longest shutdown waits for connections to close and documents to store. */
const DESTROY_TIMEOUT_MS = 10_000;

/** Resolves true when `work` finishes within `ms`, false when it does not. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  initDb({ url: config.DATABASE_URL });

  const collab = createCollabServer({
    collabTokenSecret: config.COLLAB_TOKEN_SECRET,
    internalSecret: config.INTERNAL_SECRET,
    address: config.HOST,
  });
  await collab.server.listen(config.COLLAB_PORT);
  console.log(`collab listening on ${config.HOST}:${config.COLLAB_PORT}`);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      // Closes connections and flushes pending stores before the pool closes.
      // Bounded: a document whose store keeps failing stays loaded, and
      // destroy() would otherwise wait for it forever.
      if (!(await within(collab.server.destroy(), DESTROY_TIMEOUT_MS))) {
        console.error(`collab shutdown: destroy did not finish within ${DESTROY_TIMEOUT_MS} ms`);
      }
      // Let in-flight change bookkeeping land before its database goes away.
      if (!(await within(collabSettle(collab), SETTLE_TIMEOUT_MS))) {
        console.error(`collab shutdown: change bookkeeping did not settle within ${SETTLE_TIMEOUT_MS} ms`);
      }
      await closeDb();
      process.exit(0);
    } catch (err) {
      console.error('collab shutdown failed:', err);
      process.exit(1);
    }
  };
  // Defense in depth: a stray rejection is logged and the server keeps
  // serving (exiting would drop every edit still waiting for its store).
  process.on('unhandledRejection', (reason: unknown) => {
    console.error(
      'collab: unhandled rejection (still running):',
      reason instanceof Error ? (reason.stack ?? reason.message) : reason
    );
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('collab failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
