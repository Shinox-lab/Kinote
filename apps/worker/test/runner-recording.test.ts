import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const hooks = vi.hoisted(() => ({
  completeJob: undefined as undefined | ((jobId: string) => void),
}));

vi.mock('@living-wiki/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@living-wiki/db')>();
  return {
    ...real,
    completeJob: (...args: Parameters<typeof real.completeJob>) => {
      hooks.completeJob?.(args[2]);
      return real.completeJob(...args);
    },
  };
});

import { enqueueJob, jobs, tenants, withTenantTx } from '@living-wiki/db';
import { runPendingJobsForTenant } from '../src/runner.js';
import { useTestDb } from '../../api/test/support/testkit.js';

describe('worker runner: recording an outcome fails', () => {
  useTestDb();

  it('logs the failure, leaves that job running, and continues with the rest of the batch', async () => {
    const tenantId = randomUUID();
    await withTenantTx(tenantId, (tx) =>
      tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` }).then(() => undefined)
    );
    const [a, b] = await withTenantTx(tenantId, async (tx) => [
      await enqueueJob(tx, {
        tenantId,
        queue: 'test.ok',
        idempotencyKey: 'a',
        payload: {},
        runAt: new Date(Date.now() - 2000),
      }),
      await enqueueJob(tx, {
        tenantId,
        queue: 'test.ok',
        idempotencyKey: 'b',
        payload: {},
        runAt: new Date(Date.now() - 1000),
      }),
    ]);
    hooks.completeJob = (jobId) => {
      if (jobId === a!.id) throw new Error('connection reset');
    };
    const ran: string[] = [];

    const processed = await runPendingJobsForTenant(tenantId, {
      handlers: {
        'test.ok': {
          async run(job) {
            ran.push(job.id);
          },
        },
      },
    });
    hooks.completeJob = undefined;

    expect(ran).toEqual([a!.id, b!.id]);
    expect(processed).toEqual([
      { id: a!.id, queue: 'test.ok', status: 'running' },
      { id: b!.id, queue: 'test.ok', status: 'completed' },
    ]);
    const rows = await withTenantTx(tenantId, (tx) =>
      tx.select().from(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, a!.id)))
    );
    expect(rows[0]!.status).toBe('running');
  });
});
