// CLI: re-queues page cards and entity extraction for everything indexed.
// Usage: DATABASE_MIGRATE_URL=postgres://owner:...@host/db pnpm placement:rebuild
//
// Run after setting or changing ROUTER_PROVIDER / ROUTER_MODEL, and only once
// every worker runs this release. The workers do the rebuilding; this only
// queues their jobs. Exits non-zero on any failure.
import { closeDb, initDb } from './client.js';
import { enqueuePlacementRebuild } from './placementRebuild.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATE_URL;
  if (!url) throw new Error('DATABASE_MIGRATE_URL is not set');
  const db = initDb({ url, max: 1 });
  try {
    const queued = await enqueuePlacementRebuild(db);
    console.log(`queued ${queued} placement jobs`);
  } finally {
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error('placement rebuild failed:', err);
  process.exit(1);
});
