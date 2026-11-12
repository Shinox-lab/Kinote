import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { reportModelCall } from '@kinote/core';
import {
  enqueueJob,
  usageEvents,
  jobs,
  periodOf,
  releaseHeldIndexJobs,
  tenantLimits,
  tenantUsage,
  tenants,
  withTenantTx,
} from '@kinote/db';
import { runPendingJobsForTenant } from '../src/runner.js';
import type { JobHandler } from '../src/registry.js';
import { useTestDb } from '../../api/test/support/testkit.js';

const now = new Date('2026-11-10T12:00:00Z');
const periodEnd = periodOf(1, now).end;

async function seedTenant(): Promise<string> {
  const id = randomUUID();
  await withTenantTx(id, (tx) => tx.insert(tenants).values({ id, name: `t-${id}`, slug: `t-${id}` }));
  return id;
}

/** index_credits_per_month = 1, with 1.1 credits used: the index pool is past its grace limit. */
async function indexPoolSpent(tenantId: string) {
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(tenantLimits).values({ tenantId, indexCreditsPerMonth: 1, creditsPerMonth: 1 });
    await tx.insert(tenantUsage).values({
      tenantId,
      period: periodOf(1, now).key,
      indexCreditsUsedMilli: 1100,
      creditsUsedMilli: 0,
    });
  });
}

function recording() {
  const runs: string[] = [];
  const handler: JobHandler = { run: async (job) => void runs.push(job.queue) };
  const handlers: Record<string, JobHandler> = { 'version.index': handler, 'capture.route': handler, 'version.card': handler };
  return { runs, handlers };
}

async function enqueue(tenantId: string, queue: string, payload: Record<string, unknown> = {}, key = `k-${queue}`) {
  return withTenantTx(tenantId, (tx) =>
    enqueueJob(tx, { tenantId, queue, idempotencyKey: key, payload, runAt: new Date(now.getTime() - 1000) })
  );
}

async function jobRow(tenantId: string, id: string) {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx.select().from(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
  );
  return row!;
}

describe('holding indexing at the index credit limit', () => {
  useTestDb();

  it('an index job waits until the period ends once the index pool is used up', async () => {
    const tenantId = await seedTenant();
    await indexPoolSpent(tenantId);
    const job = await enqueue(tenantId, 'version.index');
    const { runs, handlers } = recording();
    await runPendingJobsForTenant(tenantId, { handlers, now });
    expect(runs).toEqual([]);
    const row = await jobRow(tenantId, job.id);
    expect(row.status).toBe('queued');
    expect(row.runAt.toISOString()).toBe(periodEnd.toISOString());
    expect(row.attempts).toBe(0);
  });

  it('raising the limit releases it', async () => {
    const tenantId = await seedTenant();
    await indexPoolSpent(tenantId);
    const job = await enqueue(tenantId, 'version.index');
    const { runs, handlers } = recording();
    await runPendingJobsForTenant(tenantId, { handlers, now });
    await withTenantTx(tenantId, async (tx) => {
      await tx.update(tenantLimits).set({ indexCreditsPerMonth: 100 }).where(eq(tenantLimits.tenantId, tenantId));
      expect(await releaseHeldIndexJobs(tx, tenantId, now)).toBe(1);
    });
    await runPendingJobsForTenant(tenantId, { handlers, now });
    expect(runs).toEqual(['version.index']);
    expect((await jobRow(tenantId, job.id)).status).toBe('completed');
  });

  it('a new period releases it', async () => {
    const tenantId = await seedTenant();
    await indexPoolSpent(tenantId);
    const job = await enqueue(tenantId, 'version.card');
    const { runs, handlers } = recording();
    await runPendingJobsForTenant(tenantId, { handlers, now });
    expect(runs).toEqual([]);
    await runPendingJobsForTenant(tenantId, { handlers, now: new Date(periodEnd.getTime() + 60_000) });
    expect(runs).toEqual(['version.card']);
    expect((await jobRow(tenantId, job.id)).status).toBe('completed');
  });

  it('capture jobs are never held by the index pool', async () => {
    const tenantId = await seedTenant();
    await indexPoolSpent(tenantId);
    await enqueue(tenantId, 'capture.route');
    const { runs, handlers } = recording();
    await runPendingJobsForTenant(tenantId, { handlers, now });
    expect(runs).toEqual(['capture.route']);
  });

  it('a workspace without limits indexes as before', async () => {
    const tenantId = await seedTenant();
    await enqueue(tenantId, 'version.index');
    const { runs, handlers } = recording();
    await runPendingJobsForTenant(tenantId, { handlers, now });
    expect(runs).toEqual(['version.index']);
  });

  it('operator jobs (a model change re-index) are not held at the indexing limit', async () => {
    const tenantId = await seedTenant();
    await indexPoolSpent(tenantId);
    await enqueue(tenantId, 'document.reindex', { documentId: randomUUID(), operator: true }, 'op');
    await enqueue(tenantId, 'version.index');
    const runs: string[] = [];
    const handler: JobHandler = { run: async (job) => void runs.push(job.queue) };
    await runPendingJobsForTenant(tenantId, { handlers: { 'document.reindex': handler, 'version.index': handler }, now });
    expect(runs).toEqual(['document.reindex']);
  });

  it('operator jobs are free; rates can be a getter (the live model settings)', async () => {
    const tenantId = await seedTenant();
    await enqueue(tenantId, 'document.reindex', { documentId: randomUUID(), operator: true }, 'op');
    await enqueue(tenantId, 'version.index');
    const handler: JobHandler = { run: async () => reportModelCall({ model: 'm', inputTokens: 1000, outputTokens: 0, estimated: false }) };
    await runPendingJobsForTenant(tenantId, {
      handlers: { 'document.reindex': handler, 'version.index': handler },
      now,
      creditRates: () => ({ default: { input: 1, output: 0 }, models: {} }),
    });
    const events = await withTenantTx(tenantId, (tx) => tx.select().from(usageEvents).where(eq(usageEvents.tenantId, tenantId)));
    expect(events.map((e) => e.millicredits).sort((a, b) => a - b)).toEqual([0, 1000]);
  });
});
