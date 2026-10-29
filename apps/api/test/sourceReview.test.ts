import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { documents, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { makeSource, pdf, putFile, sourceWorld, type SourceWorld } from './support/sourcekit.js';

describe('how a source\'s files meet review', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  const extractor = new FakeExtractor();
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });
  const settle = (w: SourceWorld) => runPendingJobsForTenant(w.tenant.id, { storage, extractor });
  const versionsOf = (w: SourceWorld, documentId: string) =>
    withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, documentId)).orderBy(versions.number));
  const search = async (w: SourceWorld, query: string) =>
    ((await app.inject({ method: 'POST', url: '/api/v1/search', headers: w.ownerHeaders, payload: { query } })).json().passages as Array<{ documentId: string }>);
  const queue = async (w: SourceWorld) =>
    (await app.inject({ method: 'GET', url: '/api/v1/reviews', headers: w.ownerHeaders })).json() as Array<{ document: { id: string } }>;

  test('an untrusted source waits for review; once trusted, its next file is indexed with no human', async () => {
    const w = await sourceWorld(app, 'trust-co');
    const src = await makeSource(app, w.ownerHeaders, { name: 'Feed', spaceId: w.open.id });
    const first = await putFile(app, src.token, 'a', { name: 'a.pdf', data: pdf('untrusted lemming text') });
    await settle(w);
    assert.equal((await queue(w)).filter((i) => i.document.id === first.json().document.id).length, 1);
    assert.equal((await search(w, 'untrusted lemming text')).length, 0);

    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/sources/${src.id}`, headers: w.ownerHeaders, payload: { trusted: true } });
    assert.equal(patch.statusCode, 200, patch.body);
    const second = await putFile(app, src.token, 'b', { name: 'b.pdf', data: pdf('trusted marmot text') });
    await settle(w);
    assert.equal((await queue(w)).filter((i) => i.document.id === second.json().document.id).length, 0);
    assert.equal((await search(w, 'trusted marmot text')).filter((p) => p.documentId === second.json().document.id).length, 1);
    // The earlier file, read before the switch, still waits.
    assert.deepEqual((await versionsOf(w, first.json().document.id)).map((v) => v.status), ['pending_review']);
  });

  test('a trusted source in a review space still waits, and any reviewer may approve it', async () => {
    const w = await sourceWorld(app, 'trust-review-co');
    const src = await makeSource(app, w.ownerHeaders, { name: 'Strict feed', spaceId: w.strict.id, trusted: true });
    const res = await putFile(app, src.token, 'c', { name: 'c.pdf', data: pdf('review space capybara text') });
    await settle(w);
    const id = res.json().document.id as string;
    assert.equal((await queue(w)).filter((i) => i.document.id === id).length, 1);
    const [waiting] = await versionsOf(w, id);
    const approve = await app.inject({ method: 'POST', url: `/api/v1/versions/${waiting!.id}/approve`, headers: w.reviewer.headers, payload: {} });
    assert.equal(approve.statusCode, 200, approve.body);
    await settle(w);
    assert.equal((await search(w, 'review space capybara text')).filter((p) => p.documentId === id).length, 1);
  });

  test('moving a file into a review space while a newer version is being read leaves one waiting version', async () => {
    const w = await sourceWorld(app, 'move-co');
    const src = await makeSource(app, w.ownerHeaders, { name: 'Moving feed', spaceId: w.open.id, trusted: true });
    const first = await putFile(app, src.token, 'm', { name: 'm.pdf', data: pdf('first version dugong text') });
    const id = first.json().document.id as string;
    await settle(w);
    assert.equal((await search(w, 'first version dugong text')).length, 1);
    // A newer version arrives and is not read yet; then an editor (not a reviewer there) moves the file.
    await putFile(app, src.token, 'm', { name: 'm.pdf', data: pdf('second version tapir text') });
    const moved = await app.inject({ method: 'POST', url: `/api/v1/files/${id}/move`, headers: w.editor.headers, payload: { target_space_id: w.strict.id } });
    assert.equal(moved.statusCode, 200, moved.body);
    await settle(w);
    const statuses = (await versionsOf(w, id)).map((v) => v.status);
    assert.equal(statuses.filter((s) => s === 'pending_review').length, 1, statuses.join(','));
    assert.equal(statuses[statuses.length - 1], 'pending_review');
    const [doc] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(and(eq(documents.id, id))));
    assert.equal(doc!.spaceId, w.strict.id);
  });
});
