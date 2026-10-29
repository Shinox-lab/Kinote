import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  jobs,
  tenants,
  withTenantTx,
  type Job,
} from '@kinote/db';
import { useTestDb } from '../../api/test/support/testkit.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const seconds = (n: number) => new Date(NOW.getTime() + n * 1000);

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
  key: string,
  payload: Record<string, unknown> = {},
  runAt: Date = seconds(-60),
  maxAttempts?: number
): Promise<Job> {
  return withTenantTx(tenantId, (tx) =>
    enqueueJob(tx, { tenantId, queue: 'test', idempotencyKey: key, payload, runAt, maxAttempts })
  );
}

function claim(tenantId: string, now: Date = NOW, limit = 10): Promise<Job[]> {
  return withTenantTx(tenantId, (tx) => claimJobs(tx, tenantId, { now, limit, leaseSeconds: 300 }));
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

describe('leased job queue', () => {
  useTestDb();

  it('enqueueing the same key twice while queued leaves one row with the second payload', async () => {
    const tenantId = await seedTenant();
    const first = await enqueue(tenantId, 'k', { step: 1 }, seconds(10));
    const second = await enqueue(tenantId, 'k', { step: 2 }, seconds(20));
    expect(second.id).toBe(first.id);

    const rows = await withTenantTx(tenantId, (tx) =>
      tx.select().from(jobs).where(eq(jobs.tenantId, tenantId))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ step: 2 });
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.runAt.toISOString()).toBe(seconds(20).toISOString());
  });

  it('re-enqueue of a completed job resets attempts to 0 and status to queued', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k');
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(jobs)
        .set({ status: 'completed', attempts: 3 })
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, job.id)))
    );

    const revived = await enqueue(tenantId, 'k', { again: true });
    expect(revived.id).toBe(job.id);
    expect(revived.status).toBe('queued');
    expect(revived.attempts).toBe(0);
    expect(revived.payload).toEqual({ again: true });
  });

  it('re-enqueue of a dead-lettered job resets attempts to 0 and status to queued', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k');
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(jobs)
        .set({ status: 'dead_letter', attempts: 5, lastError: 'boom' })
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, job.id)))
    );

    const revived = await enqueue(tenantId, 'k');
    expect(revived.status).toBe('queued');
    expect(revived.attempts).toBe(0);
  });

  it('claimJobs returns only due jobs up to limit and marks them running with locked_at', async () => {
    const tenantId = await seedTenant();
    const a = await enqueue(tenantId, 'a', {}, seconds(-30));
    const b = await enqueue(tenantId, 'b', {}, seconds(-20));
    const c = await enqueue(tenantId, 'c', {}, seconds(-10));
    const future = await enqueue(tenantId, 'future', {}, seconds(60));

    const claimed = await claim(tenantId, NOW, 2);
    expect(claimed.map((j) => j.id)).toEqual([a.id, b.id]);
    for (const j of claimed) {
      expect(j.status).toBe('running');
      expect(j.lockedAt?.toISOString()).toBe(NOW.toISOString());
    }
    const stored = await load(tenantId, a.id);
    expect(stored.status).toBe('running');
    expect(stored.lockedAt?.toISOString()).toBe(NOW.toISOString());

    expect((await load(tenantId, c.id)).status).toBe('queued');
    expect((await load(tenantId, future.id)).status).toBe('queued');
  });

  it('a second claim returns none once every due job is claimed', async () => {
    const tenantId = await seedTenant();
    await enqueue(tenantId, 'a');
    await enqueue(tenantId, 'b');
    await enqueue(tenantId, 'future', {}, seconds(60));

    expect(await claim(tenantId)).toHaveLength(2);
    expect(await claim(tenantId)).toEqual([]);
  });

  it('claims only the given tenant’s jobs', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    await enqueue(a, 'k');
    await enqueue(b, 'k');
    const claimed = await claim(a);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.tenantId).toBe(a);
  });

  it('reclaims a job running past its lease', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k');
    expect(await claim(tenantId, NOW)).toHaveLength(1);

    expect(await claim(tenantId, seconds(299))).toEqual([]);
    const reclaimed = await claim(tenantId, seconds(301));
    expect(reclaimed.map((j) => j.id)).toEqual([job.id]);
    expect(reclaimed[0]!.status).toBe('running');
    expect(reclaimed[0]!.lockedAt?.toISOString()).toBe(seconds(301).toISOString());
  });

  it('enqueue during running sets rerun_requested, and completeJob then leaves it queued', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k', { step: 1 });
    await claim(tenantId);

    const during = await enqueue(tenantId, 'k', { step: 2 }, seconds(30));
    expect(during.status).toBe('running');
    expect(during.rerunRequested).toBe(true);

    await withTenantTx(tenantId, (tx) => completeJob(tx, tenantId, job.id));
    const after = await load(tenantId, job.id);
    expect(after.status).toBe('queued');
    expect(after.rerunRequested).toBe(false);
    expect(after.lockedAt).toBeNull();
    expect(after.payload).toEqual({ step: 2 });
    expect(after.runAt.toISOString()).toBe(seconds(30).toISOString());
  });

  it('completeJob marks a job completed and releases the lease', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k');
    await claim(tenantId);
    await withTenantTx(tenantId, (tx) => completeJob(tx, tenantId, job.id));
    const after = await load(tenantId, job.id);
    expect(after.status).toBe('completed');
    expect(after.lockedAt).toBeNull();
  });

  it('failJob retryable gives queued with run_at one second later at attempt 1 and dead_letter at attempt 5', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k', {}, seconds(-60), 5);

    const expectedDelays = [1, 2, 4, 8];
    for (let attempt = 1; attempt <= 4; attempt++) {
      await claim(tenantId, seconds(10_000 * attempt));
      const failNow = seconds(10_000 * attempt);
      const result = await withTenantTx(tenantId, (tx) =>
        failJob(tx, tenantId, job.id, { message: `fail ${attempt}`, retryable: true, now: failNow })
      );
      expect(result.status).toBe('queued');
      const row = await load(tenantId, job.id);
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toBe(`fail ${attempt}`);
      expect(row.lockedAt).toBeNull();
      expect(row.runAt.getTime() - failNow.getTime()).toBe(expectedDelays[attempt - 1]! * 1000);
    }

    await claim(tenantId, seconds(60_000));
    const fifth = await withTenantTx(tenantId, (tx) =>
      failJob(tx, tenantId, job.id, { message: 'fail 5', retryable: true, now: seconds(60_000) })
    );
    expect(fifth.status).toBe('dead_letter');
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(5);
    expect(row.lockedAt).toBeNull();
  });

  it('failJob non-retryable dead-letters on the first call', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k');
    await claim(tenantId);
    const result = await withTenantTx(tenantId, (tx) =>
      failJob(tx, tenantId, job.id, { message: 'never works', retryable: false })
    );
    expect(result.status).toBe('dead_letter');
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('never works');
    expect(row.lockedAt).toBeNull();
  });

  it('a dead-lettered job is not claimed again', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k');
    await claim(tenantId);
    await withTenantTx(tenantId, (tx) =>
      failJob(tx, tenantId, job.id, { message: 'x', retryable: false })
    );
    expect(await claim(tenantId, seconds(10_000))).toEqual([]);
  });

  describe('lease guard', () => {
    it('a stale worker cannot complete or fail a job another worker reclaimed', async () => {
      const tenantId = await seedTenant();
      const job = await enqueue(tenantId, 'k');
      const [claimA] = await claim(tenantId, NOW);
      const [claimB] = await claim(tenantId, seconds(301));
      expect(claimB!.lockedAt!.getTime()).toBe(seconds(301).getTime());

      const completeA = await withTenantTx(tenantId, (tx) =>
        completeJob(tx, tenantId, job.id, { lease: claimA!.lockedAt! })
      );
      expect(completeA.status).toBe('lost');
      let row = await load(tenantId, job.id);
      expect(row.status).toBe('running');
      expect(row.lockedAt!.toISOString()).toBe(seconds(301).toISOString());

      const failA = await withTenantTx(tenantId, (tx) =>
        failJob(tx, tenantId, job.id, { message: 'x', retryable: false, lease: claimA!.lockedAt! })
      );
      expect(failA.status).toBe('lost');
      row = await load(tenantId, job.id);
      expect(row.status).toBe('running');
      expect(row.lastError).toBeNull();
      expect(row.lockedAt!.toISOString()).toBe(seconds(301).toISOString());

      const completeB = await withTenantTx(tenantId, (tx) =>
        completeJob(tx, tenantId, job.id, { lease: claimB!.lockedAt! })
      );
      expect(completeB.status).toBe('completed');
      expect((await load(tenantId, job.id)).status).toBe('completed');
    });

    it('a lease token does not match a job that is no longer running', async () => {
      const tenantId = await seedTenant();
      const job = await enqueue(tenantId, 'k');
      const [claimed] = await claim(tenantId);
      await withTenantTx(tenantId, (tx) => completeJob(tx, tenantId, job.id));
      const again = await withTenantTx(tenantId, (tx) =>
        failJob(tx, tenantId, job.id, { message: 'x', retryable: true, lease: claimed!.lockedAt! })
      );
      expect(again.status).toBe('lost');
      expect((await load(tenantId, job.id)).status).toBe('completed');
    });

    it('matches a lease stored with microsecond precision', async () => {
      const tenantId = await seedTenant();
      const job = await enqueue(tenantId, 'k');
      await withTenantTx(tenantId, (tx) =>
        tx.execute(sql`UPDATE jobs SET status = 'running',
          locked_at = '2026-10-19T12:00:00.123456Z'::timestamptz
          WHERE tenant_id = ${tenantId} AND id = ${job.id}`)
      );
      const running = await load(tenantId, job.id);
      expect(running.lockedAt!.toISOString()).toBe('2026-10-19T12:00:00.123Z');

      const result = await withTenantTx(tenantId, (tx) =>
        completeJob(tx, tenantId, job.id, { lease: running.lockedAt! })
      );
      expect(result.status).toBe('completed');
    });

    it('completeJob and failJob report lost for a row that no longer exists', async () => {
      const tenantId = await seedTenant();
      const missing = randomUUID();
      expect(
        (await withTenantTx(tenantId, (tx) => completeJob(tx, tenantId, missing))).status
      ).toBe('lost');
      expect(
        (
          await withTenantTx(tenantId, (tx) =>
            failJob(tx, tenantId, missing, { message: 'x', retryable: false })
          )
        ).status
      ).toBe('lost');
    });
  });

  describe('failJob with rerun_requested', () => {
    it('a retry keeps counting attempts and waits for the later requested run_at', async () => {
      const tenantId = await seedTenant();
      const job = await enqueue(tenantId, 'k', { step: 1 });
      await claim(tenantId);
      await enqueue(tenantId, 'k', { step: 2 }, seconds(30));

      const result = await withTenantTx(tenantId, (tx) =>
        failJob(tx, tenantId, job.id, { message: 'temp', retryable: true, now: NOW })
      );
      expect(result.status).toBe('queued');
      const row = await load(tenantId, job.id);
      expect(row.attempts).toBe(1);
      expect(row.rerunRequested).toBe(false);
      expect(row.lockedAt).toBeNull();
      expect(row.payload).toEqual({ step: 2 });
      expect(row.runAt.toISOString()).toBe(seconds(30).toISOString());
    });

    it('a retry uses the backoff when it is later than the requested run_at', async () => {
      const tenantId = await seedTenant();
      const job = await enqueue(tenantId, 'k');
      await claim(tenantId);
      await enqueue(tenantId, 'k', {}, seconds(-5));

      await withTenantTx(tenantId, (tx) =>
        failJob(tx, tenantId, job.id, { message: 'temp', retryable: true, now: NOW })
      );
      const row = await load(tenantId, job.id);
      expect(row.attempts).toBe(1);
      expect(row.runAt.toISOString()).toBe(seconds(1).toISOString());
    });

    it('a would-be dead letter is revived with attempts 0 at the requested run_at', async () => {
      const tenantId = await seedTenant();
      const job = await enqueue(tenantId, 'k', { step: 1 });
      await claim(tenantId);
      await enqueue(tenantId, 'k', { step: 2 }, seconds(30));

      const result = await withTenantTx(tenantId, (tx) =>
        failJob(tx, tenantId, job.id, { message: 'fatal', retryable: false, now: NOW })
      );
      expect(result.status).toBe('queued');
      const row = await load(tenantId, job.id);
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(0);
      expect(row.rerunRequested).toBe(false);
      expect(row.lastError).toBe('fatal');
      expect(row.runAt.toISOString()).toBe(seconds(30).toISOString());
    });
  });

  it('reclaiming an expired lease counts an attempt and dead-letters at max_attempts', async () => {
    const tenantId = await seedTenant();
    const job = await enqueue(tenantId, 'k', {}, seconds(-60), 2);
    const first = await claim(tenantId, NOW);
    expect(first[0]!.attempts).toBe(0);

    const second = await claim(tenantId, seconds(301));
    expect(second.map((j) => [j.id, j.status, j.attempts])).toEqual([[job.id, 'running', 1]]);

    const third = await claim(tenantId, seconds(602));
    expect(third.map((j) => [j.id, j.status, j.attempts])).toEqual([[job.id, 'dead_letter', 2]]);
    const row = await load(tenantId, job.id);
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(2);
    expect(row.lockedAt).toBeNull();
    expect(row.lastError).toMatch(/lease expired/);

    expect(await claim(tenantId, seconds(10_000))).toEqual([]);
  });
});
