import { sql } from 'drizzle-orm';
import { rowsOf, type Db } from './client.js';

/**
 * Re-queues the routing engine's derived data for everything indexed: a card
 * job per page and an entity job per document, outside the Inbox and archive,
 * keyed like the jobs indexing enqueues (an existing row is revived, never
 * duplicated). Runs across tenants, so it needs the schema owner's connection
 * (as migrations do). Returns how many jobs were queued.
 *
 * Run it after the routing model is configured or changed, once every worker
 * runs a release that has the `version.card` and `version.entities` handlers.
 */
export async function enqueuePlacementRebuild(db: Db): Promise<number> {
  const result = await db.execute(sql`
    WITH indexed AS (
      SELECT d.tenant_id, d.indexed_version_id AS version_id, d.kind
        FROM documents d
        JOIN spaces s ON s.tenant_id = d.tenant_id AND s.id = d.space_id
       WHERE d.indexed_version_id IS NOT NULL
         AND d.archived_at IS NULL
         AND s.kind <> 'inbox'
    ),
    wanted AS (
      SELECT tenant_id, 'version.card' AS queue, 'card:' || version_id AS idempotency_key, version_id
        FROM indexed WHERE kind = 'page'
      UNION ALL
      SELECT tenant_id, 'version.entities', 'entities:' || version_id, version_id
        FROM indexed
    ),
    queued AS (
      INSERT INTO jobs (tenant_id, queue, idempotency_key, payload, status, attempts, max_attempts, run_at)
      SELECT tenant_id, queue, idempotency_key, jsonb_build_object('versionId', version_id), 'queued', 0, 5, now()
        FROM wanted
      ON CONFLICT (tenant_id, queue, idempotency_key) DO UPDATE SET
        payload = EXCLUDED.payload,
        status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'queued' END,
        rerun_requested = jobs.status = 'running',
        attempts = 0,
        last_error = NULL,
        run_at = EXCLUDED.run_at,
        max_attempts = EXCLUDED.max_attempts
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM queued`);
  return rowsOf<{ n: number }>(result)[0]?.n ?? 0;
}
