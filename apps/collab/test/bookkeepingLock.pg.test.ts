// The collab bookkeeping / snapshot lock protocol against a real Postgres
// (pnpm test:pg; skipped without TEST_DATABASE_URL). PGlite runs one
// transaction at a time, so only real Postgres can show that the wait comes
// from the row lock: the bookkeeping's explicit FOR KEY SHARE on the document
// row against the snapshot's FOR UPDATE (`lockDocument`).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import * as Y from 'yjs';
import {
  closeDb,
  documents,
  initDb,
  lockDocument,
  pagePendingContributors,
  pages,
  spaces,
  tenants,
  withTenantTx,
} from '@living-wiki/db';
import { writeAttribution } from '../src/recorder.js';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!APP_URL)('collab bookkeeping waits for the snapshot document lock (real Postgres)', () => {
  let owner: pg.Pool;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const pageId = randomUUID();

  beforeAll(async () => {
    if (!OWNER_URL) throw new Error('TEST_DATABASE_MIGRATE_URL must be set with TEST_DATABASE_URL');
    owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
    initDb({ url: APP_URL!, max: 4 });
    await owner.query(
      `INSERT INTO public.users (id, email, name, password_hash) VALUES ($1, $2, 'Lock', 'x')`,
      [userId, `lock-${userId}@example.test`]
    );
    await withTenantTx(tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, name: `lock-${tenantId}`, slug: `lock-${tenantId}` });
      await tx.insert(spaces).values({ id: spaceId, tenantId, name: 'S', slug: 's', createdBy: userId });
      await tx.insert(documents).values({
        id: pageId,
        tenantId,
        spaceId,
        kind: 'page',
        title: 'Locked',
        createdByType: 'user',
        createdBy: userId,
      });
      await tx.insert(pages).values({
        documentId: pageId,
        tenantId,
        spaceId,
        slug: 'locked',
        ydocState: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
      });
      // The actor is already pending: the bookkeeping's insert hits
      // ON CONFLICT DO NOTHING and takes no foreign-key lock of its own.
      await tx
        .insert(pagePendingContributors)
        .values({ tenantId, pageId, principalType: 'user', principalId: userId });
    });
  });

  afterAll(async () => {
    if (owner) {
      for (const table of ['page_pending_contributors', 'block_activity', 'jobs', 'pages', 'documents', 'spaces', 'audit_events']) {
        await owner.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]);
      }
      await owner.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
      await owner.query('DELETE FROM public.users WHERE id = $1', [userId]);
      await owner.end();
    }
    await closeDb();
  });

  async function liveUpdatedAt(): Promise<string> {
    const res = await owner.query<{ t: string }>(
      'SELECT live_updated_at::text AS t FROM public.pages WHERE tenant_id = $1 AND document_id = $2',
      [tenantId, pageId]
    );
    return res.rows[0]!.t;
  }

  it('a repeat contributor\'s write started under the snapshot lock lands only after it is released', async () => {
    const before = await liveUpdatedAt();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const snapshotTx = withTenantTx(tenantId, async (tx) => {
      await lockDocument(tx, tenantId, pageId);
      locked();
      await gate;
    });
    await lockTaken;

    let landed = false;
    const write = writeAttribution({
      tenantId,
      pageId,
      quietSeconds: 120,
      actor: { actorType: 'user', actorId: userId, source: 'human' },
      blockIds: ['b1'],
    }).then(() => {
      landed = true;
    });
    await sleep(500);
    expect(landed).toBe(false);
    expect(await liveUpdatedAt()).toBe(before);

    release();
    await snapshotTx;
    await write;
    expect(landed).toBe(true);
    expect(await liveUpdatedAt()).not.toBe(before);
  });
});
