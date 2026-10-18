import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { jobs } from './schema/foundations.js';
import { getDb, rowsOf, type DbTransaction } from './client.js';

/** A row of the `jobs` table. */
export type Job = typeof jobs.$inferSelect;

/**
 * Thrown by a job handler for a failure that can never succeed on retry (bad
 * payload, missing subject). The runner dead-letters the job at once.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

/**
 * Tenants that have a due job: queued and past `run_at`, or running with an
 * expired lease. Calls the SECURITY DEFINER function `tenants_with_due_jobs`,
 * so it needs no tenant context and no superuser; RLS still hides job rows.
 */
export async function tenantsWithDueJobs(now: Date, leaseSeconds: number): Promise<string[]> {
  const result = await getDb().execute(
    sql`SELECT public.tenants_with_due_jobs(${now.toISOString()}::timestamptz, ${leaseSeconds}::int) AS tenant_id`
  );
  return rowsOf<{ tenant_id: string }>(result).map((r) => r.tenant_id);
}

/**
 * Enqueues a job keyed by `(tenant, queue, idempotencyKey)`. On conflict the
 * payload and `run_at` are replaced and:
 * - a `queued` job stays queued;
 * - a `completed` or `dead_letter` job becomes `queued` with `attempts = 0`;
 * - a `running` job keeps running and gets `rerun_requested = true`, so
 *   `completeJob`/`failJob` put it back in the queue (with this payload and
 *   `run_at`) once the current run ends.
 */
export async function enqueueJob(
  tx: DbTransaction,
  p: {
    tenantId: string;
    queue: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
  }
): Promise<Job> {
  const runAt = p.runAt ?? new Date();
  const revived = sql`"jobs"."status" IN ('completed', 'dead_letter')`;
  const [job] = await tx
    .insert(jobs)
    .values({
      tenantId: p.tenantId,
      queue: p.queue,
      idempotencyKey: p.idempotencyKey,
      payload: p.payload,
      status: 'queued',
      attempts: 0,
      maxAttempts: p.maxAttempts ?? 5,
      runAt,
    })
    .onConflictDoUpdate({
      target: [jobs.tenantId, jobs.queue, jobs.idempotencyKey],
      set: {
        payload: sql`excluded.payload`,
        runAt: sql`excluded.run_at`,
        status: sql`CASE WHEN "jobs"."status" = 'running' THEN 'running' ELSE 'queued' END`,
        rerunRequested: sql`"jobs"."status" = 'running'`,
        attempts: sql`CASE WHEN ${revived} THEN 0 ELSE "jobs"."attempts" END`,
        lastError: sql`CASE WHEN ${revived} THEN NULL ELSE "jobs"."last_error" END`,
      },
    })
    .returning();

  return job!;
}

/**
 * Claims up to `limit` due jobs of one tenant: queued with `run_at <= now`, or
 * running with a lease older than `leaseSeconds`. A single UPDATE over a
 * `FOR UPDATE SKIP LOCKED` selection sets `status = 'running'` and
 * `locked_at = now` together, so concurrent workers never claim the same job.
 * Returned in `run_at` order. Commit the transaction before running handlers.
 */
export async function claimJobs(
  tx: DbTransaction,
  tenantId: string,
  o: { now: Date; limit: number; leaseSeconds: number }
): Promise<Job[]> {
  const leaseExpiredBefore = new Date(o.now.getTime() - o.leaseSeconds * 1000);
  const due = tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        or(
          and(eq(jobs.status, 'queued'), lte(jobs.runAt, o.now)),
          and(eq(jobs.status, 'running'), lt(jobs.lockedAt, leaseExpiredBefore))
        )
      )
    )
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(o.limit)
    .for('update', { skipLocked: true });

  const claimed = await tx
    .update(jobs)
    .set({ status: 'running', lockedAt: o.now })
    .where(and(eq(jobs.tenantId, tenantId), inArray(jobs.id, due)))
    .returning();

  return claimed.sort(
    (a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id.localeCompare(b.id)
  );
}

async function lockJob(tx: DbTransaction, tenantId: string, jobId: string): Promise<Job | undefined> {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
    .for('update');
  return job;
}

/**
 * Ends a run successfully and releases the lease: `completed`, or back to
 * `queued` (attempts reset, flag cleared) when an enqueue arrived during the run.
 */
export async function completeJob(
  tx: DbTransaction,
  tenantId: string,
  jobId: string
): Promise<{ status: 'completed' | 'queued' }> {
  const job = await lockJob(tx, tenantId, jobId);
  if (!job) return { status: 'completed' };

  const status = job.rerunRequested ? 'queued' : 'completed';
  await tx
    .update(jobs)
    .set(
      job.rerunRequested
        ? { status, rerunRequested: false, lockedAt: null, attempts: 0, lastError: null }
        : { status, lockedAt: null, lastError: null }
    )
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)));
  return { status };
}

/**
 * Ends a run with an error and releases the lease. Every call counts an
 * attempt and records `last_error`. A retryable error re-queues the job with
 * `run_at = now + 2^(attempts - 1)` seconds (1 s after the first failure, 2 s
 * after the second, ...) until `attempts` reaches `max_attempts`, when the job
 * is dead-lettered; a non-retryable error dead-letters it at once.
 *
 * When an enqueue arrived during the run (`rerun_requested`) the job is queued
 * again either way, exactly as that enqueue would have done after the failure:
 * a job that would have been dead-lettered is revived with `attempts = 0` at the
 * requested `run_at`; a retry keeps its attempt count and runs no earlier than
 * both the backoff and the requested `run_at`.
 */
export async function failJob(
  tx: DbTransaction,
  tenantId: string,
  jobId: string,
  e: { message: string; retryable: boolean; now?: Date }
): Promise<{ status: 'queued' | 'dead_letter' }> {
  const job = await lockJob(tx, tenantId, jobId);
  if (!job) return { status: 'dead_letter' };

  const now = e.now ?? new Date();
  const attempts = job.attempts + 1;
  const deadLetter = !e.retryable || attempts >= job.maxAttempts;
  const backoffRunAt = new Date(now.getTime() + 2 ** (attempts - 1) * 1000);

  let set: Partial<typeof jobs.$inferInsert>;
  if (!job.rerunRequested) {
    set = deadLetter
      ? { status: 'dead_letter', attempts }
      : { status: 'queued', attempts, runAt: backoffRunAt };
  } else if (deadLetter) {
    set = { status: 'queued', attempts: 0, rerunRequested: false };
  } else {
    const runAt = backoffRunAt > job.runAt ? backoffRunAt : job.runAt;
    set = { status: 'queued', attempts, runAt, rerunRequested: false };
  }

  await tx
    .update(jobs)
    .set({ ...set, lastError: e.message, lockedAt: null })
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)));
  return { status: set.status as 'queued' | 'dead_letter' };
}

/**
 * Records a job outcome outside the worker's claim flow and returns the
 * updated row. Thin wrapper over `completeJob` / `failJob` (retryable).
 */
export async function markJobOutcome(
  tx: DbTransaction,
  tenantId: string,
  jobId: string,
  outcome: { ok: true } | { ok: false; error: string }
): Promise<Job | null> {
  if (outcome.ok) await completeJob(tx, tenantId, jobId);
  else await failJob(tx, tenantId, jobId, { message: outcome.error, retryable: true });
  return (await lockJob(tx, tenantId, jobId)) ?? null;
}
