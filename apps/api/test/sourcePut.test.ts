import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { auditEvents, documents, jobs, sourceItems, sources, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor } from '@kinote/core';
import { ERROR_SENTENCES } from '@kinote/contracts';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { makeSource, pdf, putFile, sourceWorld, type SourceWorld } from './support/sourcekit.js';
import { uploadRequest } from './support/multipart.js';

/** Counts stored objects so a repeated or refused PUT can be shown to write nothing. */
class CountingStorage extends InMemoryObjectStorage {
  puts = 0;
  deletes: string[] = [];
  async put(tenantId: string, path: string, bytes: Uint8Array, mime: string) {
    this.puts += 1;
    return super.put(tenantId, path, bytes, mime);
  }
  async delete(tenantId: string, key: string) {
    this.deletes.push(key);
    return super.delete(tenantId, key);
  }
}

describe('PUT /api/v1/source/files/:externalId', () => {
  let storage: CountingStorage;
  let app: ReturnType<typeof buildTestApp>;
  const extractor = new FakeExtractor();
  useTestDb();
  beforeEach(() => {
    storage = new CountingStorage();
    app = buildTestApp({ storage, maxUploadBytes: 5000 });
  });
  const settle = (tenantId: string) => runPendingJobsForTenant(tenantId, { storage, extractor });

  async function setup() {
    const w = await sourceWorld(app, 'put-co');
    const src = await makeSource(app, w.ownerHeaders, { name: 'Reports', spaceId: w.open.id });
    return { w, src };
  }
  const q = <T>(w: SourceWorld, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(w.tenant.id, fn);
  const docOf = (w: SourceWorld, externalId: string) =>
    q(w, async (tx) => (await tx.select().from(documents).where(and(eq(documents.tenantId, w.tenant.id), eq(documents.externalId, externalId))))[0]!);
  const versionsOf = (w: SourceWorld, documentId: string) =>
    q(w, (tx) => tx.select().from(versions).where(eq(versions.documentId, documentId)).orderBy(versions.number));
  const search = async (w: SourceWorld, query: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: w.ownerHeaders, payload: { query } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().passages as Array<{ documentId: string; versionId: string; text: string }>;
  };
  /** Reads the file, approves its waiting version (an untrusted source always waits for review) and indexes it. */
  const publish = async (w: SourceWorld, documentId: string) => {
    await settle(w.tenant.id);
    const [waiting] = (await versionsOf(w, documentId)).filter((v) => v.status === 'pending_review');
    assert.ok(waiting, 'no version is waiting for review');
    const res = await app.inject({ method: 'POST', url: `/api/v1/versions/${waiting.id}/approve`, headers: w.ownerHeaders, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    await settle(w.tenant.id);
  };
  const badge = async (w: SourceWorld, id: string) =>
    (await app.inject({ method: 'GET', url: `/api/v1/files/${id}`, headers: w.ownerHeaders })).json().badge as string;

  test('a new external id creates a synced document owned by the source', async () => {
    const { w, src } = await setup();
    const res = await putFile(app, src.token, 'reports/q3', { name: 'q3.pdf', data: pdf('Third quarter revenue was lime green.') });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.created, true);
    assert.equal(body.unchanged, false);
    assert.equal(body.version.number, 1);

    const doc = await docOf(w, 'reports/q3');
    assert.deepEqual(
      { kind: doc.kind, placement: doc.placement, sourceId: doc.sourceId, by: [doc.createdByType, doc.createdBy], space: doc.spaceId, parent: doc.parentId, title: doc.title },
      { kind: 'file', placement: 'synced', sourceId: src.id, by: ['connector', src.id], space: w.open.id, parent: null, title: 'q3.pdf' }
    );
    const [v1] = await versionsOf(w, doc.id);
    assert.deepEqual([v1!.reason, v1!.createdByType, v1!.createdBy, v1!.status], ['source', 'connector', src.id, 'extracting']);

    const [item] = await q(w, (tx) => tx.select().from(sourceItems).where(eq(sourceItems.documentId, doc.id)));
    assert.equal(item!.externalId, 'reports/q3');
    assert.equal(item!.contentHash, v1!.contentHash);
    const [source] = await q(w, (tx) => tx.select().from(sources).where(eq(sources.id, src.id)));
    assert.ok(source!.lastSyncAt);
    const audit = await q(w, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.type, 'file.uploaded')));
    assert.deepEqual([audit[0]!.actorType, audit[0]!.actorId], ['connector', src.id]);
  });

  test('the same bytes again are unchanged and write nothing', async () => {
    const { w, src } = await setup();
    const file = { name: 'a.pdf', data: pdf('Alpha beta gamma delta.') };
    await putFile(app, src.token, 'a', file);
    const puts = storage.puts;
    const jobCount = async () => (await q(w, (tx) => tx.select().from(jobs))).length;
    const jobsBefore = await jobCount();
    const again = await putFile(app, src.token, 'a', file);
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual([again.json().unchanged, again.json().created, again.json().version.number], [true, false, 1]);
    assert.equal(storage.puts, puts, 'stored bytes again');
    assert.equal(await jobCount(), jobsBefore, 'queued a job');
    assert.equal((await versionsOf(w, (await docOf(w, 'a')).id)).length, 1);
  });

  test('changed bytes add a version in every state of the previous one', async () => {
    const { w, src } = await setup();
    const strict = await makeSource(app, w.ownerHeaders, { name: 'Strict feed', spaceId: w.strict.id });
    // v1 extracting → v2 supersedes it.
    await putFile(app, src.token, 'x', { name: 'x.pdf', data: pdf('first draft aardvark') });
    const second = await putFile(app, src.token, 'x', { name: 'x.pdf', data: pdf('second draft badger') });
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().created, false);
    const docX = await docOf(w, 'x');
    assert.deepEqual((await versionsOf(w, docX.id)).map((v) => v.status), ['superseded', 'extracting']);
    // an approved, indexed v2 keeps answering until v3 is approved and indexed.
    await publish(w, docX.id);
    assert.equal((await search(w, 'second draft badger')).filter((p) => p.documentId === docX.id).length, 1);
    const third = await putFile(app, src.token, 'x', { name: 'x.pdf', data: pdf('third draft capybara') });
    assert.equal(third.statusCode, 201);
    await settle(w.tenant.id);
    assert.equal((await search(w, 'second draft badger')).filter((p) => p.documentId === docX.id).length, 1, 'v2 stopped answering early');
    await publish(w, docX.id);
    assert.equal((await search(w, 'third draft capybara')).filter((p) => p.documentId === docX.id).length, 1);
    assert.equal((await search(w, 'second draft badger')).filter((p) => p.documentId === docX.id && /badger/.test(p.text)).length, 0);

    // pending_review: an untrusted source in a review space waits; v2 supersedes the waiting v1.
    await putFile(app, strict.token, 'y', { name: 'y.pdf', data: pdf('first waiting dingo') });
    await settle(w.tenant.id);
    const docY = await docOf(w, 'y');
    assert.equal((await versionsOf(w, docY.id))[0]!.status, 'pending_review');
    await putFile(app, strict.token, 'y', { name: 'y.pdf', data: pdf('second waiting emu') });
    assert.deepEqual((await versionsOf(w, docY.id)).map((v) => v.status), ['superseded', 'extracting']);
  });

  test("a person's replace is not overwritten by the source's identical bytes", async () => {
    const { w, src } = await setup();
    const original = { name: 'p.pdf', data: pdf('original fennec text') };
    await putFile(app, src.token, 'p', original);
    const doc = await docOf(w, 'p');
    // The owner pins the file in place (a move to the same space), then replaces it by hand.
    const moved = await app.inject({ method: 'POST', url: `/api/v1/files/${doc.id}/move`, headers: w.ownerHeaders, payload: { target_space_id: w.open.id } });
    assert.equal(moved.statusCode, 200, moved.body);
    const replaced = await app.inject(uploadRequest(`/api/v1/files/${doc.id}/versions`, w.ownerHeaders, { name: 'p.pdf', data: pdf('person edited gazelle text') }));
    assert.equal(replaced.statusCode, 201, replaced.body);

    const same = await putFile(app, src.token, 'p', original);
    assert.equal(same.statusCode, 200, same.body);
    assert.equal(same.json().unchanged, true);
    assert.equal((await versionsOf(w, doc.id)).length, 2);

    // New bytes from the source land in the person's chosen place, which is not changed.
    const strictMoved = await app.inject({ method: 'POST', url: `/api/v1/files/${doc.id}/move`, headers: w.ownerHeaders, payload: { target_space_id: w.strict.id } });
    assert.equal(strictMoved.statusCode, 200, strictMoved.body);
    const fresh = await putFile(app, src.token, 'p', { name: 'p.pdf', data: pdf('source sent hyena text') });
    assert.equal(fresh.statusCode, 201, fresh.body);
    const after = await docOf(w, 'p');
    assert.deepEqual([after.spaceId, after.placement], [w.strict.id, 'pinned']);
    assert.equal((await versionsOf(w, doc.id)).length, 3);
  });

  test('identical bytes do not reawaken a file a person withdrew', async () => {
    const { w, src } = await setup();
    const file = { name: 'w.pdf', data: pdf('withdrawn ibis text') };
    await putFile(app, src.token, 'w', file);
    const doc = await docOf(w, 'w');
    await publish(w, doc.id);
    const withdrawn = await app.inject({ method: 'POST', url: `/api/v1/files/${doc.id}/withdraw`, headers: w.ownerHeaders });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    const again = await putFile(app, src.token, 'w', file);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().unchanged, true);
    await settle(w.tenant.id);
    assert.equal((await search(w, 'withdrawn ibis text')).filter((p) => p.documentId === doc.id).length, 0);
    assert.equal((await versionsOf(w, doc.id)).length, 1);
  });

  test("a person's archive blocks the source, and nothing is left stored", async () => {
    const { w, src } = await setup();
    await putFile(app, src.token, 'z', { name: 'z.pdf', data: pdf('archived jackal text') });
    const doc = await docOf(w, 'z');
    const archived = await app.inject({ method: 'POST', url: `/api/v1/files/${doc.id}/archive`, headers: w.ownerHeaders });
    assert.equal(archived.statusCode, 200, archived.body);
    const puts = storage.puts;
    const res = await putFile(app, src.token, 'z', { name: 'z.pdf', data: pdf('changed kudu text') });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'page_archived');
    assert.match(res.json().message, /file is archived/i);
    assert.equal(storage.puts, puts, 'stored bytes for a refused PUT');
    assert.equal((await versionsOf(w, doc.id)).length, 1);
  });

  test('an archived space refuses a new file (409), and a person-archived file stays refused (409)', async () => {
    const { w } = await setup();
    const target = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: w.ownerHeaders, payload: { name: 'Temp', slug: 'temp', review_required: false } });
    const feed = await makeSource(app, w.ownerHeaders, { name: 'Temp feed', spaceId: target.json().id });
    // A space can only be archived when empty, so one file is made and archived first.
    await putFile(app, feed.token, 'old', { name: 'old.pdf', data: pdf('before archive lemur') });
    const old = await docOf(w, 'old');
    await app.inject({ method: 'POST', url: `/api/v1/files/${old.id}/archive`, headers: w.ownerHeaders });
    const archivedSpace = await app.inject({ method: 'POST', url: `/api/v1/spaces/${target.json().id}/archive`, headers: w.ownerHeaders });
    assert.equal(archivedSpace.statusCode, 200, archivedSpace.body);

    const fresh = await putFile(app, feed.token, 'new', { name: 'new.pdf', data: pdf('after archive meerkat') });
    assert.equal(fresh.statusCode, 409, fresh.body);
    assert.equal(fresh.json().error, 'space_archived');
    const existing = await putFile(app, feed.token, 'old', { name: 'old.pdf', data: pdf('after archive narwhal') });
    assert.equal(existing.statusCode, 409, existing.body);
    assert.equal(existing.json().error, 'page_archived');
    assert.equal((await q(w, (tx) => tx.select().from(documents).where(eq(documents.externalId, 'new')))).length, 0);
  });

  test('two external ids with the same bytes are two documents', async () => {
    const { w, src } = await setup();
    const file = { name: 'same.pdf', data: pdf('identical ocelot text') };
    const a = await putFile(app, src.token, 'one', file);
    const b = await putFile(app, src.token, 'two', file);
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.notEqual(a.json().document.id, b.json().document.id);
    void w;
  });

  test('external ids: the limits, Unicode and encoded slashes', async () => {
    const { w, src } = await setup();
    const ok = ['a', 'x'.repeat(256), '報告書/第3四半期 (最終).pdf', 'a%2Fb', 'dir/with spaces/and?question#hash'];
    for (const [i, id] of ok.entries()) {
      const res = await putFile(app, src.token, id, { name: `f${i}.txt`, data: `file number ${i}` });
      assert.equal(res.statusCode, 201, `${id}: ${res.body}`);
      assert.equal((await docOf(w, id)).externalId, id);
    }
    const tooLong = await putFile(app, src.token, 'x'.repeat(257), { name: 'long.txt', data: 'too long id' });
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json().error, 'validation_failed');
    const control = await putFile(app, src.token, 'a\nb', { name: 'ctl.txt', data: 'control id' });
    assert.equal(control.statusCode, 400);
    const empty = await app.inject({ ...uploadRequest('/api/v1/source/files/', { authorization: `Bearer ${src.token}` }, { name: 'e.txt', data: 'x' }), method: 'PUT' });
    assert.ok([400, 404].includes(empty.statusCode), String(empty.statusCode));
  });

  test('a slash in the external id works with or without URL-encoding, for PUT and DELETE', async () => {
    const { w, src } = await setup();
    const file = { name: 'q3.pdf', data: pdf('slash path ferret text') };
    const raw = await app.inject({ ...uploadRequest('/api/v1/source/files/reports/2026/q3', { authorization: `Bearer ${src.token}` }, file), method: 'PUT' });
    assert.equal(raw.statusCode, 201, raw.body);
    assert.equal((await docOf(w, 'reports/2026/q3')).id, raw.json().document.id);
    const encoded = await putFile(app, src.token, 'reports/2026/q3', file);
    assert.equal(encoded.statusCode, 200, encoded.body);
    assert.equal(encoded.json().document.id, raw.json().document.id);
    assert.equal(encoded.json().unchanged, true);
    const gone = await app.inject({ method: 'DELETE', url: '/api/v1/source/files/reports/2026/q3', headers: { authorization: `Bearer ${src.token}` } });
    assert.equal(gone.statusCode, 200, gone.body);
    // An empty id is refused with a plain validation error, not a sign-in prompt.
    const empty = await app.inject({ ...uploadRequest('/api/v1/source/files/', { authorization: `Bearer ${src.token}` }, file), method: 'PUT' });
    assert.equal(empty.statusCode, 400, empty.body);
  });

  test('two simultaneous PUTs of one new id make one document; different bytes end with two versions', async () => {
    const { w, src } = await setup();
    const same = { name: 's.pdf', data: pdf('simultaneous okapi text') };
    const both = await Promise.all([putFile(app, src.token, 'race', same), putFile(app, src.token, 'race', same)]);
    assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 201], both.map((r) => r.body).join(' | '));
    const docs = await q(w, (tx) => tx.select().from(documents).where(eq(documents.externalId, 'race')));
    assert.equal(docs.length, 1);
    assert.equal((await versionsOf(w, docs[0]!.id)).length, 1);

    const diff = await Promise.all([
      putFile(app, src.token, 'race2', { name: 'r.pdf', data: pdf('first pangolin text') }),
      putFile(app, src.token, 'race2', { name: 'r.pdf', data: pdf('second quokka text') }),
    ]);
    assert.deepEqual(diff.map((r) => r.statusCode), [201, 201], diff.map((r) => r.body).join(' | '));
    const docs2 = await q(w, (tx) => tx.select().from(documents).where(eq(documents.externalId, 'race2')));
    assert.equal(docs2.length, 1);
    assert.equal((await versionsOf(w, docs2[0]!.id)).length, 2);
  });

  test('refusals behave as for people and store nothing', async () => {
    const { src } = await setup();
    const puts = storage.puts;
    const unsupported = await putFile(app, src.token, 'u', { name: 'u.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    assert.equal(unsupported.statusCode, 415);
    assert.equal(unsupported.json().error, 'unsupported_file_type');
    const empty = await putFile(app, src.token, 'e', { name: 'e.txt', data: '' });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error, 'empty_file');
    const big = await putFile(app, src.token, 'b', { name: 'b.txt', data: 'x'.repeat(6000) });
    assert.equal(big.statusCode, 413);
    assert.equal(big.json().message, ERROR_SENTENCES.file_too_large);
    const none = await putFile(app, src.token, 'n', null);
    assert.equal(none.statusCode, 400);
    assert.equal(storage.puts, puts);
  });

  test('an approved PUT is indexed and searchable', async () => {
    const { w, src } = await setup();
    const res = await putFile(app, src.token, 'idx', { name: 'idx.pdf', data: pdf('Searchable tapir sentence for the source feed.') });
    const id = res.json().document.id as string;
    await publish(w, id);
    assert.equal(await badge(w, id), 'Indexed · v1');
    assert.equal((await search(w, 'searchable tapir sentence')).filter((p) => p.documentId === id).length, 1);
  });
});
