import { eq, sql } from 'drizzle-orm';
import type { ModelSettingsInput } from '@kinote/contracts';
import { rowsOf, type Db, type DbTransaction } from './client.js';
import { modelSettings } from './schema/usage.js';

/** The control plane's stored model settings, or null when none were set. Not tenant-scoped. */
export async function readModelSettings(db: Pick<Db, 'select'>): Promise<ModelSettingsInput | null> {
  const [row] = await db.select().from(modelSettings).where(eq(modelSettings.id, true));
  if (!row) return null;
  return {
    askModel: row.askModel,
    routerModel: row.routerModel,
    embeddingModel: row.embeddingModel,
    creditRates: row.creditRates ?? null,
  };
}

/** Replaces the stored model settings (one row). */
export async function writeModelSettings(db: Pick<Db | DbTransaction, 'insert'>, value: ModelSettingsInput): Promise<void> {
  const values = { ...value, updatedAt: new Date() };
  await db.insert(modelSettings).values({ id: true, ...values }).onConflictDoUpdate({ target: modelSettings.id, set: values });
}

/**
 * Queues the work a model change needs, across workspaces (cp_queue_model_rebuild): a re-index of every document
 * with chunks from another embedding model, and/or the placement rebuild. Jobs are operator jobs (free, never held).
 */
export async function queueModelRebuild(
  db: Pick<Db | DbTransaction, 'execute'>,
  o: { embeddingModel: string; reindex: boolean; placement: boolean }
): Promise<{ reindex: number; placement: number }> {
  const result = await db.execute(sql`SELECT * FROM public.cp_queue_model_rebuild(${o.embeddingModel}, ${o.reindex}, ${o.placement})`);
  const row = rowsOf<{ reindex_jobs: number; placement_jobs: number }>(result)[0];
  return { reindex: Number(row?.reindex_jobs ?? 0), placement: Number(row?.placement_jobs ?? 0) };
}

/** Operator jobs (model change work) still queued or running, across workspaces. */
export async function pendingModelJobs(db: Pick<Db, 'execute'>): Promise<number> {
  const result = await db.execute(sql`SELECT public.cp_model_jobs_pending() AS n`);
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
}
