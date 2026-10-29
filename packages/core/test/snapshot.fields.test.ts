import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { collectionFields, collections, pages, versions, withTenantTx } from '@living-wiki/db';
import { FIELDS_MAP, fieldLines } from '@living-wiki/contracts';
import { BLOCK_FRAGMENT } from '@living-wiki/collab';
import { collectionFieldDefs, fieldNames, rowCollectionOf, takePageSnapshot } from '../src/index.js';
import { buildTestApp, bootstrapTenant, useTestDb } from '../../../apps/api/test/support/testkit.js';

type Headers = Record<string, string>;

/** Field values ride in the page document and into its versions (C3). */
describe('snapshots carry field values', () => {
  const app = buildTestApp();
  useTestDb();

  async function world() {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Fields Co', slug: 'fields-co' });
    const space = (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers, payload: { name: 'Clients', slug: 'clients' } })).json();
    const page = async (title: string, slug: string, parentId: string | null = null) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers,
        payload: { space_id: space.id, parent_id: parentId, title, slug, markdown: `${title} notes.` },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const clients = await page('Clients', 'clients');
    const george = await page('George', 'george', clients);
    const plain = await page('Plain', 'plain');
    const [status, launch] = await withTenantTx(tenant.id, async (tx) => {
      await tx.insert(collections).values({ tenantId: tenant.id, documentId: clients, createdBy: owner.userId });
      return tx
        .insert(collectionFields)
        .values([
          { tenantId: tenant.id, collectionId: clients, name: 'Status', type: 'select', position: 'a0', options: { choices: [{ id: 'active', name: 'Active', color: 'green' }] } },
          { tenantId: tenant.id, collectionId: clients, name: 'Launch date', type: 'date', position: 'a1' },
        ])
        .returning();
    });
    return { tenant, owner, headers: headers as Headers, spaceId: space.id as string, clients, george, plain, status: status!, launch: launch! };
  }

  /** Changes the stored page document as a live edit would, then lets a snapshot read it. */
  async function edit(tenantId: string, pageId: string, fn: (doc: Y.Doc) => void) {
    await withTenantTx(tenantId, async (tx) => {
      const [row] = await tx.select().from(pages).where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(row!.ydocState));
      fn(doc);
      await tx
        .update(pages)
        .set({ ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)), liveChangedSinceSnapshot: true })
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
    });
  }

  const snap = (tenantId: string, actorId: string, pageId: string, manual = false) =>
    takePageSnapshot({ tenantId, pageId, reason: 'submit', actorType: 'user', actorId, manual });

  test('pages without fields keep their content hash', async () => {
    const w = await world();
    const v = await snap(w.tenant.id, w.owner.userId, w.plain, true);
    expect(v!.contentHash).toBe(createHash('sha256').update(`# Plain\n\n${v!.markdown}`, 'utf8').digest('hex'));
    expect(v!.fields).toBeNull();
  });

  test('a field change makes a new version with fields', async () => {
    const w = await world();
    const first = await snap(w.tenant.id, w.owner.userId, w.george, true);
    await edit(w.tenant.id, w.george, (doc) => doc.getMap(FIELDS_MAP).set(w.status.id, 'active'));
    const second = await snap(w.tenant.id, w.owner.userId, w.george, true);
    expect(second!.id).not.toBe(first!.id);
    expect(second!.fields).toEqual({ [w.status.id]: 'active' });
    // Unchanged since: no new version.
    await expect(snap(w.tenant.id, w.owner.userId, w.george, true)).rejects.toMatchObject({ code: 'no_changes' });
  });

  test('a row with only fields is snapshotted; a plain empty page is not', async () => {
    const w = await world();
    const clear = (doc: Y.Doc) => {
      const f = doc.getXmlFragment(BLOCK_FRAGMENT);
      f.delete(0, f.length);
    };
    await edit(w.tenant.id, w.george, (doc) => {
      clear(doc);
      doc.getMap(FIELDS_MAP).set(w.launch.id, { start: '2026-12-01' });
    });
    const row = await snap(w.tenant.id, w.owner.userId, w.george);
    expect(row).not.toBeNull();
    expect(row!.fields).toEqual({ [w.launch.id]: { start: '2026-12-01' } });

    // A row whose only values don't fit their fields has nothing to snapshot.
    await edit(w.tenant.id, w.george, (doc) => doc.getMap(FIELDS_MAP).set(w.launch.id, 'December'));
    expect(await snap(w.tenant.id, w.owner.userId, w.george)).toBeNull();

    await edit(w.tenant.id, w.plain, (doc) => {
      clear(doc);
      doc.getMap(FIELDS_MAP).set(w.launch.id, { start: '2026-12-01' });
    });
    expect(await snap(w.tenant.id, w.owner.userId, w.plain)).toBeNull();
  });

  test('a value Postgres can’t store is left out of the version, never failing it', async () => {
    const w = await world();
    await edit(w.tenant.id, w.george, (doc) => {
      doc.getMap(FIELDS_MAP).set(w.status.id, 'active');
      doc.getMap(FIELDS_MAP).set(w.launch.id, { start: '2026-12-01', note: 'x\u0000' });
    });
    const v = await snap(w.tenant.id, w.owner.userId, w.george, true);
    expect(v!.fields).toEqual({ [w.status.id]: 'active' });
  });

  test('ill-typed values are left out of the header', async () => {
    const w = await world();
    await edit(w.tenant.id, w.george, (doc) => {
      doc.getMap(FIELDS_MAP).set(w.status.id, 'not-a-choice');
      doc.getMap(FIELDS_MAP).set(w.launch.id, { start: '2026-12-01' });
    });
    const v = await snap(w.tenant.id, w.owner.userId, w.george, true);
    const lines = await withTenantTx(w.tenant.id, async (tx) => {
      const row = await rowCollectionOf(tx, w.tenant.id, w.george);
      expect(row?.collectionId).toBe(w.clients);
      expect(await rowCollectionOf(tx, w.tenant.id, w.plain)).toBeNull();
      const defs = await collectionFieldDefs(tx, w.tenant.id, w.clients);
      const raw = v!.fields as Record<string, unknown>;
      return fieldLines(defs, raw, await fieldNames(tx, w.tenant.id, defs, raw, w.spaceId));
    });
    expect(lines).toEqual(['Launch date: 2026-12-01 (1 December 2026)']);
    const [stored] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, v!.id)));
    expect(stored!.fields).toEqual({ [w.status.id]: 'not-a-choice', [w.launch.id]: { start: '2026-12-01' } });
  });
});
