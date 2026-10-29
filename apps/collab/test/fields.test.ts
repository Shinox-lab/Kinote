import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import { blockActivity, pageFieldValues, pagePendingContributors, withTenantTx } from '@kinote/db';
import { AppError, FIELDS_MAP, canonicalFieldJson } from '@kinote/contracts';
import { HttpCollabClient } from '@kinote/shared';
import { changedBlockIds, changesPage, collabSettle, type CollabServer } from '../src/server.js';
import { readBlocks } from './support/blocks.js';
import { buildCollabWorld, storedDoc, TEST_INTERNAL_SECRET, waitFor } from './support/collabWorld.js';
import { connectClient, startCollabServer, type ConnectedClient } from './support/wsClient.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

describe('field values in the page document', () => {
  test('a fields change is a page change attributed to field:<id>', () => {
    const doc = new Y.Doc();
    const seen: Array<{ changes: boolean; ids: string[] }> = [];
    doc.on('afterTransaction', (tx: Y.Transaction) => seen.push({ changes: changesPage(tx), ids: changedBlockIds(tx).sort() }));
    doc.transact(() => {
      doc.getMap(FIELDS_MAP).set('f1', 'x');
      doc.getMap(FIELDS_MAP).set('f2', { start: '2026-12-01' });
    });
    doc.transact(() => doc.getMap(FIELDS_MAP).delete('f1'));
    doc.transact(() => doc.getMap('other').set('k', 1));
    expect(seen).toEqual([
      { changes: true, ids: ['field:f1', 'field:f2'] },
      { changes: true, ids: ['field:f1'] },
      { changes: false, ids: [] },
    ]);
  });
});

describe('collab carries field values', () => {
  const app = buildTestApp();
  const clients: ConnectedClient[] = [];
  let server: CollabServer;
  let port: number;
  let collab: HttpCollabClient;

  beforeAll(async () => {
    ({ server, port } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new HttpCollabClient(`http://127.0.0.1:${port}`, TEST_INTERNAL_SECRET);
  });
  useTestDb();
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const projection = (tenantId: string, pageId: string) =>
    withTenantTx(tenantId, (tx) =>
      tx
        .select({ fieldId: pageFieldValues.fieldId, value: pageFieldValues.value })
        .from(pageFieldValues)
        .where(and(eq(pageFieldValues.tenantId, tenantId), eq(pageFieldValues.pageId, pageId)))
    );

  test('set-fields applies values, null clears; stored, mirrored and attributed', async () => {
    const w = await buildCollabWorld(app);
    const [f1, f2, f3] = [randomUUID(), randomUUID(), randomUUID()];
    const actor = { type: 'user' as const, id: w.editor.userId };
    await collab.setFields({ tenantId: w.tenant.id, pageId: w.pageA.id, values: { [f1]: 'Active', [f2]: 3, [f3]: true }, actor, source: 'human' });
    await collab.setFields({ tenantId: w.tenant.id, pageId: w.pageA.id, values: { [f3]: null }, actor, source: 'human' });

    expect((await storedDoc(w.tenant.id, w.pageA.id)).getMap(FIELDS_MAP).toJSON()).toEqual({ [f1]: 'Active', [f2]: 3 });
    expect((await projection(w.tenant.id, w.pageA.id)).sort((a, b) => a.fieldId.localeCompare(b.fieldId))).toEqual(
      [
        { fieldId: f1, value: 'Active' },
        { fieldId: f2, value: 3 },
      ].sort((a, b) => a.fieldId.localeCompare(b.fieldId))
    );

    await collabSettle(server);
    const activity = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(blockActivity).where(and(eq(blockActivity.tenantId, w.tenant.id), eq(blockActivity.pageId, w.pageA.id)))
    );
    expect(activity.map((a) => a.blockId).sort()).toEqual([`field:${f1}`, `field:${f2}`, `field:${f3}`].sort());
    expect(activity.every((a) => a.actorId === w.editor.userId)).toBe(true);
    const pending = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .select()
        .from(pagePendingContributors)
        .where(and(eq(pagePendingContributors.tenantId, w.tenant.id), eq(pagePendingContributors.pageId, w.pageA.id)))
    );
    expect(pending.map((p) => p.principalId)).toContain(w.editor.userId);
  });

  test('a live client writing the fields map is mirrored when the page is stored', async () => {
    const w = await buildCollabWorld(app);
    const f1 = randomUUID();
    const client = await connectClient({ port, documentName: w.docName(w.pageB.id), token: w.token(w.pageB.id, 'user', w.editor.userId) });
    clients.push(client);
    client.doc.getMap(FIELDS_MAP).set(f1, 'typed live');
    await waitFor(() => server.documents.get(w.docName(w.pageB.id))?.getMap(FIELDS_MAP).get(f1) === 'typed live');
    await collab.flush(w.docName(w.pageB.id));
    expect(await projection(w.tenant.id, w.pageB.id)).toEqual([{ fieldId: f1, value: 'typed live' }]);
  });

  test('a value Postgres can’t store never stops the page from being saved', async () => {
    const w = await buildCollabWorld(app);
    const [bad, good] = [randomUUID(), randomUUID()];
    const client = await connectClient({ port, documentName: w.docName(w.pageB.id), token: w.token(w.pageB.id, 'user', w.editor.userId) });
    clients.push(client);
    client.doc.getMap(FIELDS_MAP).set(bad, 'a\u0000b');
    client.doc.getMap(FIELDS_MAP).set(good, 'fine');
    await waitFor(() => server.documents.get(w.docName(w.pageB.id))?.getMap(FIELDS_MAP).get(good) === 'fine');
    await collab.flush(w.docName(w.pageB.id));
    expect((await storedDoc(w.tenant.id, w.pageB.id)).getMap(FIELDS_MAP).get(good)).toBe('fine');
    expect(await projection(w.tenant.id, w.pageB.id)).toEqual([{ fieldId: good, value: 'fine' }]);
  });

  test('replace-blocks with fields replaces the whole fields map', async () => {
    const w = await buildCollabWorld(app);
    const [f1, f2] = [randomUUID(), randomUUID()];
    const actor = { type: 'user' as const, id: w.owner.userId };
    await collab.setFields({ tenantId: w.tenant.id, pageId: w.pageA.id, values: { [f1]: 'old' }, actor, source: 'human' });
    await collab.replaceBlocks({
      tenantId: w.tenant.id,
      pageId: w.pageA.id,
      title: 'Page A',
      blocks: [{ id: 'b1', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Back', styles: {} }], children: [] }],
      fields: { [f2]: 'restored' },
      actor,
      source: 'restore',
    });
    expect((await storedDoc(w.tenant.id, w.pageA.id)).getMap(FIELDS_MAP).toJSON()).toEqual({ [f2]: 'restored' });
  });
  const para = (id: string, text: string) => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });

  test('set_field sets and clears a value in the same change as block ops', async () => {
    const w = await buildCollabWorld(app);
    const f1 = randomUUID();
    const actor = { type: 'agent' as const, id: w.agentId };
    await collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.pageA.id,
      actor,
      source: 'agent',
      ops: [
        { op: 'insert_after', after: null, blocks: [para('n1', 'Launch moved.')] },
        { op: 'set_field', fieldId: f1, value: { start: '2026-12-01' } },
      ],
    });
    let doc = await storedDoc(w.tenant.id, w.pageA.id);
    expect(doc.getMap(FIELDS_MAP).get(f1)).toEqual({ start: '2026-12-01' });
    expect(readBlocks(doc)[0].id).toBe('n1');
    await collab.applyBlockOps({ tenantId: w.tenant.id, pageId: w.pageA.id, actor, source: 'agent', ops: [{ op: 'set_field', fieldId: f1, value: null }] });
    doc = await storedDoc(w.tenant.id, w.pageA.id);
    expect(doc.getMap(FIELDS_MAP).has(f1)).toBe(false);
  });

  test('set_field with a stale expected value changes nothing', async () => {
    const w = await buildCollabWorld(app);
    const f1 = randomUUID();
    await collab.setFields({ tenantId: w.tenant.id, pageId: w.pageA.id, values: { [f1]: 'opt-lead' }, actor: { type: 'user', id: w.editor.userId }, source: 'human' });
    const before = readBlocks(await storedDoc(w.tenant.id, w.pageA.id)).map((b) => b.id);
    const err = await collab
      .applyBlockOps({
        tenantId: w.tenant.id,
        pageId: w.pageA.id,
        actor: { type: 'agent', id: w.agentId },
        source: 'agent',
        ops: [
          { op: 'insert_after', after: null, blocks: [para('n1', 'Should not land.')] },
          { op: 'set_field', fieldId: f1, value: 'opt-active', expected: canonicalFieldJson('other') },
        ],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('block_changed');
    const doc = await storedDoc(w.tenant.id, w.pageA.id);
    expect(doc.getMap(FIELDS_MAP).get(f1)).toBe('opt-lead');
    expect(readBlocks(doc).map((b) => b.id)).toEqual(before);
  });

  test('set_field expected "null" matches an absent field', async () => {
    const w = await buildCollabWorld(app);
    const f1 = randomUUID();
    await collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.pageA.id,
      actor: { type: 'agent', id: w.agentId },
      source: 'agent',
      ops: [{ op: 'set_field', fieldId: f1, value: 'opt-active', expected: 'null' }],
    });
    expect((await storedDoc(w.tenant.id, w.pageA.id)).getMap(FIELDS_MAP).get(f1)).toBe('opt-active');
  });
});
