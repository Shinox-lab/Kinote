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
 * running with a lease older than `leaseSeconds`. A `FOR UPDATE SKIP LOCKED`
 * selection locks them, then one UPDATE sets `status = 'running'` and
 * `locked_at = now` together, so concurrent workers never claim the same job.
 *
 * Reclaiming an expired lease counts the abandoned run as an attempt
 * (`attempts + 1`); when that reaches `max_attempts` the job is dead-lettered
 * instead of claimed, so a handler that crashes or hangs is not reclaimed
 * forever. Such rows come back with `status = 'dead_letter'`: do not run them
 * (call the queue's dead-letter hook instead). Every other returned row is
 * `running`, and its `locked_at` is the lease token for `completeJob`/`failJob`.
 * Returned in `run_at` order. Commit the transaction before running handlers.
 */
export async function claimJobs(
  tx: DbTransaction,
  tenantId: string,
  o: { now: Date; limit: number; leaseSeconds: number }
): Promise<Job[]> {
  const leaseExpiredBefore = new Date(o.now.getTime() - o.leaseSeconds * 1000);
  // Lock the due rows first, in their own statement. Inlining this SELECT as
  // `id IN (... LIMIT n FOR UPDATE SKIP LOCKED)` inside the UPDATE is unsafe:
  // Postgres may plan it as a nested-loop semi join that re-runs the subquery
  // per outer row, and each re-run can lock a different set, so one claim
  // could take more than `limit` jobs. The locks are held until commit.
  const due = await tx
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
  if (due.length === 0) return [];

  // In SET, column references are the row's values before this update.
  const reclaim = sql`"jobs"."status" = 'running'`;
  const exhausted = sql`(${reclaim} AND "jobs"."attempts" + 1 >= "jobs"."max_attempts")`;
  const claimed = await tx
    .update(jobs)
    .set({
      status: sql`CASE WHEN ${exhausted} THEN 'dead_letter' ELSE 'running' END`,
      lockedAt: sql`CASE WHEN ${exhausted} THEN NULL ELSE ${o.now.toISOString()}::timestamptz END`,
      attempts: sql`CASE WHEN ${reclaim} THEN "jobs"."attempts" + 1 ELSE "jobs"."attempts" END`,
      rerunRequested: sql`CASE WHEN ${exhausted} THEN false ELSE "jobs"."rerun_requested" END`,
      lastError: sql`CASE WHEN ${exhausted}
        THEN 'lease expired after ' || ${o.leaseSeconds}::int || ' s on the final attempt'
        ELSE "jobs"."last_error" END`,
    })
    .where(and(eq(jobs.tenantId, tenantId), inArray(jobs.id, due.map((d) => d.id))))
    .returning();

  return claimed.sort(
    (a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id.localeCompare(b.id)
  );
}

/**
 * Locks the job row for an outcome update. With a lease token (the `locked_at`
 * of the caller's claim) the row must still be `running` under that lease;
 * compared at millisecond precision because a JS Date carries no microseconds.
 */
async function lockJob(
  tx: DbTransaction,
  tenantId: string,
  jobId: string,
  lease?: Date
): Promise<Job | undefined> {
  const [job] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.id, jobId),
        lease
          ? and(
              eq(jobs.status, 'running'),
              sql`date_trunc('milliseconds', ${jobs.lockedAt}) =
                date_trunc('milliseconds', ${lease.toISOString()}::timestamptz)`
            )
          : undefined
      )
    )
    .for('update');
  return job;
}

/** Postgres text cannot hold NUL; error messages can. */
function storableMessage(message: string): string {
  return message.replace(/\u0000/g, '');
}

/**
 * Ends a run successfully and releases the lease: `completed`, or back to
 * `queued` (attempts reset, flag cleared) when an enqueue arrived during the run.
 * Pass `lease` (the claimed job's `locked_at`): if the job is no longer running
 * under that lease (it expired and another worker reclaimed it), or the row is
 * gone, nothing changes and the result is `lost`.
 */
export async function completeJob(
  tx: DbTransaction,
  tenantId: string,
  jobId: string,
  o: { lease?: Date } = {}
): Promise<{ status: 'completed' | 'queued' | 'lost' }> {
  const job = await lockJob(tx, tenantId, jobId, o.lease);
  if (!job) return { status: 'lost' };

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
 * is dead-lettered; a non-retryable error dead-letters it at once. `now` is the
 * failure time (default: the wall clock at this call).
 *
 * When an enqueue arrived during the run (`rerun_requested`) the job is queued
 * again either way, exactly as that enqueue would have done after the failure:
 * a job that would have been dead-lettered is revived with `attempts = 0` at the
 * requested `run_at`; a retry keeps its attempt count and runs no earlier than
 * both the backoff and the requested `run_at`.
 *
 * `lease` works as in `completeJob`: a lost lease or a missing row changes
 * nothing and returns `lost`.
 */
export async function failJob(
  tx: DbTransaction,
  tenantId: string,
  jobId: string,
  e: { message: string; retryable: boolean; now?: Date; lease?: Date }
): Promise<{ status: 'queued' | 'dead_letter' | 'lost' }> {
  const job = await lockJob(tx, tenantId, jobId, e.lease);
  if (!job) return { status: 'lost' };

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
    .set({ ...set, lastError: storableMessage(e.message), lockedAt: null })
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)));
  return { status: set.status as 'queued' | 'dead_letter' };
}

/**
 * Puts claimed jobs that were never started back in the queue (worker
 * shutdown). Only rows still running under the given lease are touched, and
 * no attempt is counted.
 */
export async function releaseJobs(
  tx: DbTransaction,
  tenantId: string,
  claimed: Array<{ id: string; lockedAt: Date | null }>
): Promise<void> {
  for (const job of claimed) {
    if (!job.lockedAt) continue;
    const row = await lockJob(tx, tenantId, job.id, job.lockedAt);
    if (!row) continue;
    await tx
      .update(jobs)
      // Not started yet, so a pending rerun is satisfied by the next run.
      .set({ status: 'queued', lockedAt: null, rerunRequested: false })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, job.id)));
  }
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
