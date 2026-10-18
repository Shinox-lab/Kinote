import { and, eq, sql } from 'drizzle-orm';
import { jobs } from './schema/foundations.js';
import { getDb, rowsOf, type DbTransaction } from './client.js';

/**
 * Tenants that have a due job: queued and past `run_at`, or running with an
 * expired lease. Calls the SECURITY DEFINER function `tenants_with_due_jobs`,
 * so it needs no tenant context and no superuser; RLS still hides job rows.
 */
export async function tenantsWithDueJobs(now: Date, leaseSeconds: number): Promise<string[]> {
  const result = await getDb().execute(
    sql`SELECT tenants_with_due_jobs(${now.toISOString()}::timestamptz, ${leaseSeconds}::int) AS tenant_id`
  );
  return rowsOf<{ tenant_id: string }>(result).map((r) => r.tenant_id);
}

export async function enqueueJob(
  tx: DbTransaction,
  params: {
    tenantId: string;
    queue: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
  }
) {
  const runAt = params.runAt ?? new Date();
  const [job] = await tx
    .insert(jobs)
    .values({
      tenantId: params.tenantId,
      queue: params.queue,
      idempotencyKey: params.idempotencyKey,
      payload: params.payload,
      status: 'queued',
      attempts: 0,
      maxAttempts: params.maxAttempts ?? 5,
      runAt,
    })
    .onConflictDoUpdate({
      target: [jobs.tenantId, jobs.queue, jobs.idempotencyKey],
      set: {
        payload: params.payload,
        status: 'queued',
        runAt,
        lastError: null,
      },
    })
    .returning();

  return job;
}

export async function markJobOutcome(
  tx: DbTransaction,
  tenantId: string,
  jobId: string,
  outcome: { ok: true } | { ok: false; error: string }
) {
  const [existing] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)));

  if (!existing) return null;

  if (outcome.ok) {
    const [updated] = await tx
      .update(jobs)
      .set({ status: 'completed', attempts: existing.attempts + 1, lastError: null })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
      .returning();
    return updated;
  }

  const nextAttempts = existing.attempts + 1;
  const isDeadLetter = nextAttempts >= existing.maxAttempts;
  const [updated] = await tx
    .update(jobs)
    .set({
      status: isDeadLetter ? 'dead_letter' : 'queued',
      attempts: nextAttempts,
      lastError: outcome.error,
      runAt: new Date(Date.now() + Math.pow(2, nextAttempts) * 1000),
    })
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
    .returning();
  return updated;
}
