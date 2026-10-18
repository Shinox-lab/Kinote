import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AppError } from '@living-wiki/contracts';
import {
  NonRetryableError,
  enqueueJob,
  jobs,
  tenants,
  withTenantTx,
  type Job,
} from '@living-wiki/db';
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
});
