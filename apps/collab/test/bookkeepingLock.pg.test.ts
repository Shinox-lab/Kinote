// The collab bookkeeping / snapshot lock protocol against a real Postgres
// (pnpm test:pg; skipped without TEST_DATABASE_URL). PGlite runs one
// transaction at a time, so only real Postgres can show that the wait comes
// from the row lock: the bookkeeping's explicit FOR KEY SHARE on the document
// row against the snapshot's FOR UPDATE (`lockDocument`).
//
// The write under test touches nothing else the lock holder holds, and fires
// no foreign-key check that could lock the document row on its behalf: the
// actor is already pending (ON CONFLICT DO NOTHING) and block b1 already has
// a row (ON CONFLICT DO UPDATE leaves page_id alone, so no RI check). Without
// the explicit statement it would commit while the lock is held.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import {
  blockActivity,
  closeDb,
  documents,
  getDb,
  initDb,
  lockDocument,
  pagePendingContributors,
  pages,
  spaces,
  tenants,
  users,
  withTenantTx,
} from '@living-wiki/db';
import { writeAttribution } from '../src/recorder.js';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    await getDb()
      .insert(users)
      .values({ id: userId, email: `lock-${userId}@example.test`, name: 'Lock', passwordHash: 'x' });
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
      // A repeat contributor of an existing block: no FK check on either insert.
      await tx
        .insert(pagePendingContributors)
        .values({ tenantId, pageId, principalType: 'user', principalId: userId });
      await tx.insert(blockActivity).values({
        tenantId,
        pageId,
        blockId: 'b1',
        actorType: 'user',
        actorId: userId,
        changedAt: new Date(Date.now() - 60_000),
      });
    });
  });

  afterAll(async () => {
    if (owner) {
      for (const table of ['page_pending_contributors', 'block_activity', 'jobs', 'pages', 'documents', 'spaces']) {
        await owner.query(`DELETE FROM public.${table} WHERE tenant_id = $1`, [tenantId]);
      }
      await owner.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
      await owner.query('DELETE FROM public.users WHERE id = $1', [userId]);
      await owner.end();
    }
    await closeDb();
  });

  /** Committed state, read over a separate superuser connection. */
  async function committed() {
    const res = await owner.query<{ live: string; changed: string; pending: string | null }>(
      `SELECT p.live_updated_at::text AS live,
              (SELECT changed_at::text FROM public.block_activity
                WHERE tenant_id = $1 AND page_id = $2 AND block_id = 'b1') AS changed,
              (SELECT xmin::text FROM public.page_pending_contributors
                WHERE tenant_id = $1 AND page_id = $2 AND principal_type = 'user' AND principal_id = $3) AS pending
         FROM public.pages p WHERE p.tenant_id = $1 AND p.document_id = $2`,
      [tenantId, pageId, userId]
    );
    return res.rows[0]!;
  }

  it("a repeat contributor's write started under the snapshot lock commits wholly after it", async () => {
    const before = await committed();
    expect(before.pending).not.toBeNull();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    // Stands in for takePageSnapshot: lock, (read), consume the pending rows, commit.
    const snapshotTx = withTenantTx(tenantId, async (tx) => {
      await lockDocument(tx, tenantId, pageId);
      locked();
      await gate;
      await tx
        .delete(pagePendingContributors)
        .where(
          and(eq(pagePendingContributors.tenantId, tenantId), eq(pagePendingContributors.pageId, pageId))
        );
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

    // While the lock is held nothing of the write has committed.
    await sleep(500);
    expect(landed).toBe(false);
    const during = await committed();
    expect(during.live).toBe(before.live);
    expect(during.changed).toBe(before.changed);
    expect(during.pending).toBe(before.pending);

    release();
    await snapshotTx;
    await write;
    expect(landed).toBe(true);

    // The write landed after the snapshot consumed the pending rows: the
    // actor is pending again (for the next snapshot), and the page and block
    // moved on only now.
    const after = await committed();
    expect(after.pending).not.toBeNull();
    expect(after.pending).not.toBe(before.pending);
    expect(after.live).not.toBe(before.live);
    expect(after.changed).not.toBe(before.changed);
  });
});
