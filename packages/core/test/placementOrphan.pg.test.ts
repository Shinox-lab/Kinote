// The orphan-entity delete against a real Postgres (pnpm test:pg): PGlite runs
// one transaction at a time, so the race with a concurrent extraction job can
// only be shown here.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  closeDb,
  documents,
  entities,
  entityMentions,
  initDb,
  spaces,
  tenants,
  versions,
  withTenantTx,
  type DbTransaction,
} from '@kinote/db';
import { deleteOrphanEntities } from '../src/index.js';

const APP_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!APP_URL)('orphan entity delete on real Postgres', () => {
  let app: pg.Pool;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const entityId = randomUUID();
  const docs = [randomUUID(), randomUUID()] as const;
  const vers = [randomUUID(), randomUUID()] as const;

  beforeAll(async () => {
    app = new pg.Pool({ connectionString: APP_URL, max: 3 });
    initDb({ url: APP_URL!, max: 2 });
    await withTenantTx(tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` });
      await tx.insert(spaces).values({ id: spaceId, tenantId, name: 's', slug: 's', createdBy: userId });
      for (const [i, id] of docs.entries()) {
        await tx.insert(documents).values({ id, tenantId, spaceId, kind: 'page', title: `d${i}`, createdByType: 'user', createdBy: userId });
        await tx.insert(versions).values({
          id: vers[i],
          tenantId,
          documentId: id,
          number: 1,
          title: `d${i}`,
          status: 'indexed',
          contentHash: `h${i}`,
          reason: 'quiet',
          createdByType: 'user',
          createdBy: userId,
        });
      }
      await tx.insert(entities).values({
        id: entityId,
        tenantId,
        kind: 'other',
        name: 'Billing Service',
        normalizedName: 'billing service',
        nameEmbedding: new Array<number>(2560).fill(0.01),
      });
      await tx.insert(entityMentions).values({
        tenantId, entityId, documentId: docs[0], versionId: vers[0], spaceId, blockIds: [],
      });
    });
  });

  afterAll(async () => {
    await app.end();
    await closeDb();
  });

  it('a withdraw racing an extraction job that adds a mention neither fails nor loses the mention', async () => {
    const job = await app.connect();
    const api = await app.connect();
    try {
      // The job, mid phase C: a new mention of the entity, not yet committed.
      await job.query('BEGIN');
      await job.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await job.query(
        `INSERT INTO entity_mentions (tenant_id, entity_id, document_id, version_id, space_id, block_ids)
         VALUES ($1, $2, $3, $4, $5, '{}')`,
        [tenantId, entityId, docs[1], vers[1], spaceId]
      );

      // The api: withdraws the first document, whose mention was the only committed one.
      await api.query('BEGIN');
      await api.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await api.query(`DELETE FROM entity_mentions WHERE tenant_id = $1 AND document_id = $2`, [tenantId, docs[0]]);
      const orphanDelete = deleteOrphanEntities(drizzle(api) as unknown as DbTransaction, tenantId, [entityId]).then(
        () => 'ok',
        (err: { code?: string; cause?: { code?: string } }) => `failed: ${err.cause?.code ?? err.code ?? 'unknown'}`
      );

      await new Promise((r) => setTimeout(r, 300));
      await job.query('COMMIT');
      expect(await orphanDelete).toBe('ok');
      await api.query('COMMIT');
    } finally {
      await job.query('ROLLBACK').catch(() => {});
      await api.query('ROLLBACK').catch(() => {});
      job.release();
      api.release();
    }

    const left = await withTenantTx(tenantId, async (tx) => ({
      entities: await tx.select().from(entities),
      mentions: await tx.select().from(entityMentions),
    }));
    expect(left.entities.map((e) => e.id)).toEqual([entityId]);
    expect(left.mentions.map((m) => m.documentId)).toEqual([docs[1]]);
  });
});
