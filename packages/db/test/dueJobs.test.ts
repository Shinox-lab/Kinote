import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../src/testing.js';
import {
  getDb,
  jobs,
  rowsOf,
  tenants,
  tenantsWithDueJobs,
  withTenantTx,
  withUntenantedTx,
} from '../src/index.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const minutes = (n: number) => n * 60_000;

type JobStatus = 'queued' | 'running' | 'completed' | 'dead_letter';

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

async function seedJob(
  tenantId: string,
  job: { status: JobStatus; runAt?: Date; lockedAt?: Date | null }
): Promise<void> {
  await withTenantTx(tenantId, (tx) =>
    tx
      .insert(jobs)
      .values({
        tenantId,
        queue: 'test',
        idempotencyKey: randomUUID(),
        payload: {},
        status: job.status,
        runAt: job.runAt ?? new Date(NOW.getTime() - minutes(1)),
        lockedAt: job.lockedAt ?? null,
      })
      .then(() => undefined)
  );
}

describe('tenants_with_due_jobs', () => {
  beforeEach(async () => {
    const { reset } = await createTestDb();
    await reset();
  });

  it('finds a tenant with a due job although RLS hides every job row', async () => {
    const tenantId = await seedTenant();
    await seedJob(tenantId, { status: 'queued' });

    const visible = await withUntenantedTx(async (tx) =>
      rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from jobs`))
    );
    expect(visible[0]!.n).toBe(0);
    expect(await tenantsWithDueJobs(NOW, 300)).toEqual([tenantId]);
  });

  it('returns each tenant once and only tenants with due work', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await seedJob(a, { status: 'queued' });
    await seedJob(a, { status: 'queued' });
    await seedJob(b, { status: 'queued', runAt: new Date(NOW.getTime() + minutes(5)) });
    expect(await tenantsWithDueJobs(NOW, 300)).toEqual([a]);
  });

  it('treats a stale running job as due only past the lease', async () => {
    const tenantId = await seedTenant();
    await seedJob(tenantId, {
      status: 'running',
      lockedAt: new Date(NOW.getTime() - minutes(10)),
    });
    expect(await tenantsWithDueJobs(NOW, 300)).toEqual([tenantId]);
    expect(await tenantsWithDueJobs(NOW, 3600)).toEqual([]);
  });

  it('ignores completed and dead_letter jobs', async () => {
    const tenantId = await seedTenant();
    await seedJob(tenantId, { status: 'completed' });
    await seedJob(tenantId, { status: 'dead_letter' });
    expect(await tenantsWithDueJobs(NOW, 300)).toEqual([]);
  });

  it('is executable by the app role and not by PUBLIC', async () => {
    const res = await getDb().execute(sql`
      select
        has_function_privilege('public', 'tenants_with_due_jobs(timestamptz,int)', 'EXECUTE') as pub,
        has_function_privilege('living_wiki_app', 'tenants_with_due_jobs(timestamptz,int)', 'EXECUTE') as app
    `);
    const row = rowsOf<{ pub: boolean; app: boolean }>(res)[0]!;
    expect(row.pub).toBe(false);
    expect(row.app).toBe(true);
  });
});
