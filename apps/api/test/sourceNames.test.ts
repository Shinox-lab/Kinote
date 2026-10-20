import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { versions, withTenantTx } from '@living-wiki/db';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor } from '@living-wiki/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { makeSource, pdf, putFile, sourceWorld } from './support/sourcekit.js';

describe('a source is named wherever its work is listed', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });

  async function setup() {
    const w = await sourceWorld(app, 'names-co');
    const src = await makeSource(app, w.ownerHeaders, { name: 'Finance feed', spaceId: w.open.id });
    const put = await putFile(app, src.token, 'f', { name: 'f.pdf', data: pdf('names test text') });
    await runPendingJobsForTenant(w.tenant.id, { storage, extractor: new FakeExtractor() });
    return { w, src, documentId: put.json().document.id as string };
  }
  const updates = async (headers: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: '/api/v1/updates', headers })).json() as Array<{ document: { id: string }; actor: unknown }>;
  const fileVersionNames = async (headers: Record<string, string>, id: string) =>
    ((await app.inject({ method: 'GET', url: `/api/v1/files/${id}/versions`, headers })).json() as Array<{ createdByName: string }>).map((v) => v.createdByName);

  test('Updates and the file history say "System · {source name}"', async () => {
    const { w, documentId } = await setup();
    const item = (await updates(w.viewer.headers)).find((u) => u.document.id === documentId);
    assert.deepEqual(item?.actor, { type: 'system', id: null, name: 'System · Finance feed' });
    assert.deepEqual(await fileVersionNames(w.ownerHeaders, documentId), ['System · Finance feed']);
  });

  test('renaming the source renames it everywhere at once', async () => {
    const { w, src, documentId } = await setup();
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/sources/${src.id}`, headers: w.ownerHeaders, payload: { name: 'Accounts feed' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(await fileVersionNames(w.ownerHeaders, documentId), ['System · Accounts feed']);
    assert.equal(((await updates(w.ownerHeaders)).find((u) => u.document.id === documentId)!.actor as { name: string }).name, 'System · Accounts feed');
  });

  test("a page's version list names a source too", async () => {
    const { w, src } = await setup();
    const page = (await app.inject({ method: 'POST', url: '/api/v1/pages', headers: w.ownerHeaders, payload: { space_id: w.open.id, title: 'Notes', slug: 'notes', markdown: 'Body.' } })).json() as { id: string };
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(versions).values({
        tenantId: w.tenant.id, documentId: page.id, number: 9, title: 'x', status: 'superseded',
        contentHash: `h-${randomUUID()}`, reason: 'source', createdByType: 'connector', createdBy: src.id,
      })
    );
    const list = (await app.inject({ method: 'GET', url: `/api/v1/pages/${page.id}/versions`, headers: w.viewer.headers })).json() as Array<{ number: number; createdByName: string }>;
    assert.equal(list.find((v) => v.number === 9)?.createdByName, 'System · Finance feed');
  });

  test("a connector id with no source in this tenant, or another tenant's source, reads as plain System", async () => {
    const { w, documentId } = await setup();
    const other = await sourceWorld(app, 'names-other');
    const foreign = await makeSource(app, other.ownerHeaders, { name: 'Foreign secret feed', spaceId: other.open.id });
    for (const id of [randomUUID(), foreign.id]) {
      await withTenantTx(w.tenant.id, (tx) =>
        tx.insert(versions).values({
          tenantId: w.tenant.id, documentId, number: 50 + Math.floor(Math.random() * 40), title: 'x', status: 'superseded',
          contentHash: `h-${randomUUID()}`, reason: 'source', createdByType: 'connector', createdBy: id,
        })
      );
    }
    const names = await fileVersionNames(w.ownerHeaders, documentId);
    assert.equal(names.filter((n) => n === 'System').length, 2);
    assert.ok(!JSON.stringify(names).includes('Foreign secret feed'));
    assert.ok(!JSON.stringify(await updates(w.ownerHeaders)).includes('Foreign secret feed'));
  });
});
