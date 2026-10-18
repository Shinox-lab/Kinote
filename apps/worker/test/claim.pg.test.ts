// Concurrent job claims against a real Postgres (pnpm test:pg): two pool
// connections run claimJobs at the same time and must get disjoint jobs, which
// only holds with a real `FOR UPDATE SKIP LOCKED`. Runs as the living_wiki_app
// role (TEST_DATABASE_URL); jobs are seeded through withTenantTx so RLS
// applies. TEST_DATABASE_MIGRATE_URL (superuser) is used only for cleanup.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import {
  claimJobs,
  closeDb,
  enqueueJob,
  initDb,
  tenants,
  withTenantTx,
  type Job,
} from '@living-wiki/db';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;
const LEASE_SECONDS = 300;

describe.skipIf(!APP_URL)('claimJobs on real Postgres', () => {
  const seeded: string[] = [];

  beforeAll(() => {
    initDb({ url: APP_URL!, max: 4 });
  });

  afterAll(async () => {
    if (OWNER_URL && seeded.length > 0) {
      const owner = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
      try {
        await owner.query('DELETE FROM public.jobs WHERE tenant_id = ANY($1::uuid[])', [seeded]);
        await owner.query('DELETE FROM public.tenants WHERE id = ANY($1::uuid[])', [seeded]);
      } finally {
        await owner.end();
      }
    }
    await closeDb();
  });

  async function seedTenantWithDueJobs(count: number): Promise<{ tenantId: string; jobIds: string[] }> {
    const tenantId = randomUUID();
    seeded.push(tenantId);
    const runAt = new Date(Date.now() - 60_000);
    const jobIds = await withTenantTx(tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, name: `claim-${tenantId}`, slug: `claim-${tenantId}` });
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const job = await enqueueJob(tx, {
          tenantId,
          queue: 'claim-test',
          idempotencyKey: `job-${i}`,
          payload: { i },
          runAt,
        });
        ids.push(job.id);
      }
      return ids;
    });
    return { tenantId, jobIds };
  }

  const claim = (tenantId: string, extra?: (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0]) => Promise<void>) =>
    withTenantTx(tenantId, async (tx) => {
      await extra?.(tx);
      return claimJobs(tx, tenantId, { now: new Date(), limit: 10, leaseSeconds: LEASE_SECONDS });
    });

  const ids = (jobs: Job[]) => jobs.map((j) => j.id);

  it('two concurrent claims over 20 due jobs get 10 each, disjoint, covering all 20', async () => {
    const { tenantId, jobIds } = await seedTenantWithDueJobs(20);

    const [first, second] = await Promise.all([claim(tenantId), claim(tenantId)]);

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    const overlap = ids(first).filter((id) => ids(second).includes(id));
    expect(overlap).toEqual([]);
    expect(new Set([...ids(first), ...ids(second)])).toEqual(new Set(jobIds));
    for (const job of [...first, ...second]) expect(job.status).toBe('running');
  });

  it('a claim skips rows locked by an open claim instead of waiting for them', async () => {
    const { tenantId, jobIds } = await seedTenantWithDueJobs(20);

    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstClaimed!: (jobs: Job[]) => void;
    const firstHasClaimed = new Promise<Job[]>((resolve) => (firstClaimed = resolve));

    // The first transaction claims and keeps its row locks until released.
    const firstTx = withTenantTx(tenantId, async (tx) => {
      const jobs = await claimJobs(tx, tenantId, { now: new Date(), limit: 10, leaseSeconds: LEASE_SECONDS });
      firstClaimed(jobs);
      await firstMayCommit;
      return jobs;
    });

    const first = await firstHasClaimed;
    // While the first transaction is still open, a second connection claims.
    // Without SKIP LOCKED it would block on the first claim's row locks; the
    // lock_timeout turns that into an error instead of a hang.
    let second: Job[];
    try {
      second = await claim(tenantId, async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      });
    } finally {
      releaseFirst();
      await firstTx;
    }

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([]);
    expect(new Set([...ids(first), ...ids(second)])).toEqual(new Set(jobIds));
  });
});
