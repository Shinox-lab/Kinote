import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AppError } from '@kinote/contracts';
import {
  NonRetryableError,
  claimJobs,
  enqueueJob,
  jobs,
  tenants,
  withTenantTx,
  type Job,
} from '@kinote/db';
import { runPendingJobsForTenant, runWorkerLoop } from '../src/runner.js';
import type { JobHandler } from '../src/registry.js';
import { useTestDb } from '../../api/test/support/testkit.js';

async function seedTenant(): Promise<string> {
  const id = randomUUID();
  await withTenantTx(id, (tx) =>
    tx
      .insert(tenants)
      .values({ id, name: `t-${id}`, slug: `t-${id}` })
      .then(() => undefined)
  );
  return id;
}

function enqueue(
  tenantId: string,
  queue: string,
  key = 'k',
  payload: Record<string, unknown> = {},
  maxAttempts?: number
): Promise<Job> {
  return withTenantTx(tenantId, (tx) =>
    enqueueJob(tx, {
      tenantId,
      queue,
      idempotencyKey: key,
      payload,
      runAt: new Date(Date.now() - 1000),
      maxAttempts,
    })
  );
}

async function load(tenantId: string, jobId: string): Promise<Job> {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobId)))
  );
  return row!;
}

function throwing(error: () => Error) {
  const runs: string[] = [];
  const deadLetters: Array<{ id: string; error: string }> = [];
  const handler: JobHandler = {
    async run(job) {
      runs.push(job.id);
      throw error();
    },
    async onDeadLetter(job, message) {
      deadLetters.push({ id: job.id, error: message });
    },
  };
  return { handler, runs, deadLetters };
}

describe('worker runner', () => {
  useTestDb();

  it('a handler throwing NonRetryableError dead-letters after one attempt and onDeadLetter is called once', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'test.fatal');
    const t = throwing(() => new NonRetryableError('cannot ever work'));

    const processed = await runPendingJobsForTenant(tenantId, {
      handlers: { 'test.fatal': t.handler },
    });

    expect(t.runs).toEqual([job.id]);
    expect(t.deadLetters).toEqual([{ id: job.id, error: 'cannot ever work' }]);
    expect(processed).toEqual([{ id: job.id, queue: 'test.fatal', status: 'dead_letter' }]);
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('cannot ever work');
    expect(row.lockedAt).toBeNull();
  });

  it('a handler throwing Error retries: queued after the first failure', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'test.flaky');
    const t = throwing(() => new Error('temporary'));

    const processed = await runPendingJobsForTenant(tenantId, {
      handlers: { 'test.flaky': t.handler },
    });

    expect(t.runs).toEqual([job.id]);
    expect(t.deadLetters).toEqual([]);
    expect(processed).toEqual([{ id: job.id, queue: 'test.flaky', status: 'queued' }]);
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('temporary');
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('calls onDeadLetter once when retries run out', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'test.flaky', 'k', {}, 1);
    const t = throwing(() => new Error('still broken'));

    await runPendingJobsForTenant(tenantId, { handlers: { 'test.flaky': t.handler } });

    expect(t.deadLetters).toEqual([{ id: job.id, error: 'still broken' }]);
    expect((await load(tenantId, job.id)).status).toBe('dead_letter');
  });

  it('an AppError below 500 is not retried; embedding_unavailable (503) is', async () => {
    const tenantId = await seedTenant();
    const client = await enqueue(tenantId, 'test.client', 'a');
    const unavailable = await enqueue(tenantId, 'test.unavailable', 'b');

    await runPendingJobsForTenant(tenantId, {
      handlers: {
        'test.client': throwing(() => new AppError('page_not_found')).handler,
        'test.unavailable': throwing(() => new AppError('embedding_unavailable')).handler,
      },
    });

    expect((await load(tenantId, client.id)).status).toBe('dead_letter');
    expect((await load(tenantId, unavailable.id)).status).toBe('queued');
  });

  it('records the cause of a failure in last_error and passes it and the final attempt count to onDeadLetter', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'test.caused', 'k', {}, 1);
    const seen: Array<{ attempts: number; error: string }> = [];

    await runPendingJobsForTenant(tenantId, {
      handlers: {
        'test.caused': {
          async run() {
            const err = new AppError('embedding_unavailable');
            err.cause = new Error('socket hang up');
            throw err;
          },
          async onDeadLetter(j, error) {
            seen.push({ attempts: j.attempts, error });
          },
        },
      },
    });

    const row = await load(tenantId, job.id);
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('socket hang up');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.attempts).toBe(1);
    expect(seen[0]!.error).toContain('socket hang up');
  });

  it('an unknown queue dead-letters', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'no.such.queue');

    const processed = await runPendingJobsForTenant(tenantId, { handlers: {} });

    expect(processed).toEqual([{ id: job.id, queue: 'no.such.queue', status: 'dead_letter' }]);
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('dead_letter');
    expect(row.lastError).toMatch(/no.such.queue/);
  });

  it('runs jobs enqueued by other jobs in later passes', async () => {
    const tenantId = await seedTenant();
    const first = await enqueue(tenantId, 'test.first');
    const ran: string[] = [];

    const processed = await runPendingJobsForTenant(tenantId, {
      handlers: {
        'test.first': {
          async run(job) {
            ran.push(job.queue);
            await enqueue(tenantId, 'test.second');
          },
        },
        'test.second': {
          async run(job) {
            ran.push(job.queue);
          },
        },
      },
    });

    expect(ran).toEqual(['test.first', 'test.second']);
    expect(processed.map((p) => [p.queue, p.status])).toEqual([
      ['test.first', 'completed'],
      ['test.second', 'completed'],
    ]);
    expect((await load(tenantId, first.id)).status).toBe('completed');
  });

  it('runs the handler outside the claim transaction, with the job already running', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'test.observe');
    let seen: { status: string; lockedAt: Date | null } | undefined;

    await runPendingJobsForTenant(tenantId, {
      handlers: {
        'test.observe': {
          async run() {
            // A fresh transaction sees the committed claim.
            const row = await load(tenantId, job.id);
            seen = { status: row.status, lockedAt: row.lockedAt };
          },
        },
      },
    });

    expect(seen?.status).toBe('running');
    expect(seen?.lockedAt).not.toBeNull();
    expect((await load(tenantId, job.id)).status).toBe('completed');
  });

  it('runWorkerLoop processes due jobs for each tenant until the signal aborts', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const ja = await enqueue(a, 'test.ok');
    const jb = await enqueue(b, 'test.ok');
    const controller = new AbortController();
    const ran: string[] = [];

    const loop = runWorkerLoop({
      intervalMs: 10,
      signal: controller.signal,
      handlers: {
        'test.ok': {
          async run(job) {
            ran.push(job.id);
            if (ran.length === 2) controller.abort();
          },
        },
      },
    });
    await loop;

    expect(ran.sort()).toEqual([ja.id, jb.id].sort());
    expect((await load(a, ja.id)).status).toBe('completed');
    expect((await load(b, jb.id)).status).toBe('completed');
  });

  it('computes retry backoff from the failure time, not the pass start', async () => {
    const tenantId = await seedTenant();
    const base = Date.now();
    let t = base;
    const clock = () => new Date(t);
    const job = await enqueue(tenantId, 'test.slow');
    let runs = 0;

    await runPendingJobsForTenant(tenantId, {
      clock,
      handlers: {
        'test.slow': {
          async run() {
            runs++;
            t += 10_000; // the handler takes 10 s, then the embedding service is unavailable
            throw new AppError('embedding_unavailable');
          },
        },
      },
    });

    expect(runs).toBe(1);
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.runAt.getTime()).toBe(base + 10_000 + 1_000);
  });

  it('leases each pass from the clock at claim time', async () => {
    const tenantId = await seedTenant();
    const base = Date.now();
    let t = base;
    const clock = () => new Date(t);
    await enqueue(tenantId, 'test.first');
    let secondLockedAt: Date | null = null;

    await runPendingJobsForTenant(tenantId, {
      clock,
      handlers: {
        'test.first': {
          async run() {
            t += 5_000;
            await withTenantTx(tenantId, (tx) =>
              enqueueJob(tx, {
                tenantId,
                queue: 'test.second',
                idempotencyKey: 'k2',
                payload: {},
                runAt: new Date(t),
              })
            );
          },
        },
        'test.second': {
          async run(job) {
            secondLockedAt = job.lockedAt;
          },
        },
      },
    });

    expect(secondLockedAt).not.toBeNull();
    expect(secondLockedAt!.getTime()).toBe(base + 5_000);
  });

  it('records a lost lease without dead-lettering or calling onDeadLetter', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'test.stale');
    const deadLetters: string[] = [];
    let reclaimedLockedAt: Date | null = null;

    const processed = await runPendingJobsForTenant(tenantId, {
      handlers: {
        'test.stale': {
          async run() {
            // Another worker reclaims the job after this run's lease expired.
            const [reclaimed] = await withTenantTx(tenantId, (tx) =>
              claimJobs(tx, tenantId, {
                now: new Date(Date.now() + 301_000),
                limit: 10,
                leaseSeconds: 300,
              })
            );
            reclaimedLockedAt = reclaimed!.lockedAt;
            throw new NonRetryableError('fatal');
          },
          async onDeadLetter(j) {
            deadLetters.push(j.id);
          },
        },
      },
    });

    expect(processed).toEqual([{ id: job.id, queue: 'test.stale', status: 'lost' }]);
    expect(deadLetters).toEqual([]);
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('running');
    expect(row.lockedAt!.getTime()).toBe(reclaimedLockedAt!.getTime());
  });

  it('dead-letters a job whose expired lease used its last attempt, calling onDeadLetter once', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'test.crashy', 'k', {}, 1);
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(jobs)
        .set({ status: 'running', lockedAt: new Date(Date.now() - 600_000) })
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, job.id)))
    );
    const t = throwing(() => new Error('unreachable'));

    const processed = await runPendingJobsForTenant(tenantId, {
      handlers: { 'test.crashy': t.handler },
    });

    expect(t.runs).toEqual([]);
    expect(t.deadLetters).toHaveLength(1);
    expect(t.deadLetters[0]!.error).toMatch(/lease expired/);
    expect(processed).toEqual([{ id: job.id, queue: 'test.crashy', status: 'dead_letter' }]);
    expect((await load(tenantId, job.id)).status).toBe('dead_letter');
  });

  it('stops between jobs when the signal aborts and releases claimed jobs it did not start', async () => {
    const tenantId = await seedTenant();
    const first = await withTenantTx(tenantId, (tx) =>
      enqueueJob(tx, {
        tenantId,
        queue: 'test.abort',
        idempotencyKey: 'a',
        payload: {},
        runAt: new Date(Date.now() - 2000),
      })
    );
    const second = await enqueue(tenantId, 'test.abort', 'b');
    const controller = new AbortController();
    const ran: string[] = [];

    const processed = await runPendingJobsForTenant(tenantId, {
      signal: controller.signal,
      handlers: {
        'test.abort': {
          async run(job) {
            ran.push(job.id);
            controller.abort();
          },
        },
      },
    });

    expect(ran).toEqual([first.id]);
    expect(processed).toEqual([{ id: first.id, queue: 'test.abort', status: 'completed' }]);
    const released = await load(tenantId, second.id);
    expect(released.status).toBe('queued');
    expect(released.lockedAt).toBeNull();
    expect(released.attempts).toBe(0);
  });

  it('on abort, still calls onDeadLetter once for dead-lettered rows in the un-started slice', async () => {
    const tenantId = await seedTenant();
    const first = await withTenantTx(tenantId, (tx) =>
      enqueueJob(tx, {
        tenantId,
        queue: 'test.abort',
        idempotencyKey: 'a',
        payload: {},
        runAt: new Date(Date.now() - 2000),
      })
    );
    // A crashed run whose expired lease used its last attempt: claimJobs
    // returns it as dead_letter, after `first`.
    const crashed = await enqueue(tenantId, 'test.abort', 'b', {}, 1);
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(jobs)
        .set({ status: 'running', lockedAt: new Date(Date.now() - 600_000) })
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, crashed.id)))
    );
    const controller = new AbortController();
    const ran: string[] = [];
    const deadLetters: string[] = [];
    const handler: JobHandler = {
      async run(job) {
        ran.push(job.id);
        controller.abort();
      },
      async onDeadLetter(job) {
        deadLetters.push(job.id);
      },
    };

    const processed = await runPendingJobsForTenant(tenantId, {
      signal: controller.signal,
      handlers: { 'test.abort': handler },
    });

    expect(ran).toEqual([first.id]);
    expect(deadLetters).toEqual([crashed.id]);
    expect(processed).toEqual([
      { id: first.id, queue: 'test.abort', status: 'completed' },
      { id: crashed.id, queue: 'test.abort', status: 'dead_letter' },
    ]);
    expect((await load(tenantId, crashed.id)).status).toBe('dead_letter');

    // A later run does not notify it again.
    await runPendingJobsForTenant(tenantId, { handlers: { 'test.abort': handler } });
    expect(deadLetters).toEqual([crashed.id]);
  });

  it('does not start a claimed job whose lease expired while earlier jobs in the batch ran', async () => {
    const tenantId = await seedTenant();
    const base = Date.now();
    let t = base;
    const clock = () => new Date(t);
    const first = await withTenantTx(tenantId, (tx) =>
      enqueueJob(tx, {
        tenantId,
        queue: 'test.slow',
        idempotencyKey: 'a',
        payload: {},
        runAt: new Date(base - 2000),
      })
    );
    const second = await enqueue(tenantId, 'test.slow', 'b');
    const ran: string[] = [];

    const processed = await runPendingJobsForTenant(tenantId, {
      clock,
      handlers: {
        'test.slow': {
          async run(job) {
            ran.push(job.id);
            t += 300_000; // exactly one lease: the second job's lease is now expired
          },
        },
      },
    });

    expect(ran).toEqual([first.id]);
    expect(processed).toEqual([
      { id: first.id, queue: 'test.slow', status: 'completed' },
      { id: second.id, queue: 'test.slow', status: 'skipped_expired' },
    ]);
    // Left exactly as claimed, for reclaim by the expired-lease path.
    const left = await load(tenantId, second.id);
    expect(left.status).toBe('running');
    expect(left.lockedAt!.getTime()).toBe(base);
    expect(left.attempts).toBe(0);

    // Once the lease is past, a later run reclaims and runs it under a new lease.
    t += 1_000;
    const later = await runPendingJobsForTenant(tenantId, {
      clock,
      handlers: {
        'test.slow': {
          async run(job) {
            ran.push(job.id);
            expect(job.lockedAt!.getTime()).toBe(t);
          },
        },
      },
    });
    expect(ran).toEqual([first.id, second.id]);
    expect(later).toEqual([{ id: second.id, queue: 'test.slow', status: 'completed' }]);
    expect((await load(tenantId, second.id)).status).toBe('completed');
  });
});
