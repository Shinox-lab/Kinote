import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { auditEvents, chunks, documents, sourceItems, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, signUpMember, useTestDb } from './support/testkit.js';
import { deleteFile, makeSource, pdf, putFile, sourceWorld, type SourceWorld } from './support/sourcekit.js';
import { uploadRequest } from './support/multipart.js';

describe('DELETE /api/v1/source/files/:externalId, revive and dismiss', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  const extractor = new FakeExtractor();
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });
  const settle = (tenantId: string) => runPendingJobsForTenant(tenantId, { storage, extractor });

  async function setup() {
    const w = await sourceWorld(app, 'del-co');
    const src = await makeSource(app, w.ownerHeaders, { name: 'Reports', spaceId: w.open.id });
    return { w, src };
  }
  const q = <T>(w: SourceWorld, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(w.tenant.id, fn);
  const docOf = (w: SourceWorld, externalId: string) =>
    q(w, async (tx) => (await tx.select().from(documents).where(and(eq(documents.tenantId, w.tenant.id), eq(documents.externalId, externalId))))[0]!);
  const versionsOf = (w: SourceWorld, documentId: string) =>
    q(w, (tx) => tx.select().from(versions).where(eq(versions.documentId, documentId)).orderBy(versions.number));
  const itemOf = (w: SourceWorld, documentId: string) =>
    q(w, async (tx) => (await tx.select().from(sourceItems).where(eq(sourceItems.documentId, documentId)))[0]!);
  const chunkCount = async (w: SourceWorld, documentId: string) =>
    (await q(w, (tx) => tx.select().from(chunks).where(eq(chunks.documentId, documentId)))).length;
  const search = async (w: SourceWorld, query: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: w.ownerHeaders, payload: { query } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().passages as Array<{ documentId: string }>;
  };
  const details = async (w: SourceWorld, id: string) =>
    (await app.inject({ method: 'GET', url: `/api/v1/files/${id}`, headers: w.ownerHeaders })).json();
  const approveWaiting = async (w: SourceWorld, documentId: string) => {
    const [waiting] = (await versionsOf(w, documentId)).filter((v) => v.status === 'pending_review');
    assert.ok(waiting, 'no version waits for review');
    const res = await app.inject({ method: 'POST', url: `/api/v1/versions/${waiting.id}/approve`, headers: w.ownerHeaders, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
  };
  /** PUT, read, approve and index: the file answers search. */
  const publish = async (w: SourceWorld, token: string, id: string, ...pages: string[]) => {
    const res = await putFile(app, token, id, { name: `${id}.pdf`, data: pdf(...pages) });
    assert.equal(res.statusCode, 201, res.body);
    await settle(w.tenant.id);
    await approveWaiting(w, res.json().document.id);
    await settle(w.tenant.id);
    return res.json().document.id as string;
  };
  const dismiss = (headers: Record<string, string>, id: string) =>
    app.inject({ method: 'POST', url: `/api/v1/files/${id}/dismiss-removal`, headers });
  const events = (w: SourceWorld, type: string) =>
    q(w, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.type, type as never)));

  test('DELETE of an indexed file leaves the index at once and says it was removed at source', async () => {
    const { w, src } = await setup();
    const id = await publish(w, src.token, 'gone', 'The wombat ledger is closed on Fridays.');
    assert.equal((await search(w, 'wombat ledger closed')).filter((p) => p.documentId === id).length, 1);

    const res = await deleteFile(app, src.token, 'gone');
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { removed: true });
    assert.equal((await search(w, 'wombat ledger closed')).filter((p) => p.documentId === id).length, 0);
    assert.equal(await chunkCount(w, id), 0);
    const doc = await docOf(w, 'gone');
    assert.ok(doc.sourceDeletedAt);
    assert.equal(doc.indexedVersionId, null);
    assert.deepEqual((await versionsOf(w, id)).map((v) => v.status), ['withdrawn']);
    assert.ok((await itemOf(w, id)).deletedAt);
    assert.equal((await details(w, id)).badge, 'Removed at source');
    const [event] = await events(w, 'source.item_deleted');
    assert.deepEqual([event!.actorType, event!.actorId, event!.subjectId], ['connector', src.id, id]);
  });

  test('an unknown id and another source\'s id are 404; deleting twice is 200 with one event', async () => {
    const { w, src } = await setup();
    const other = await makeSource(app, w.ownerHeaders, { name: 'Other feed', spaceId: w.open.id });
    await putFile(app, other.token, 'theirs', { name: 't.pdf', data: pdf('another source made this') });
    for (const res of [await deleteFile(app, src.token, 'nope'), await deleteFile(app, src.token, 'theirs')]) {
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error, 'document_not_found');
    }
    assert.equal((await docOf(w, 'theirs')).sourceDeletedAt, null);

    await putFile(app, src.token, 'mine', { name: 'm.pdf', data: pdf('removed twice') });
    assert.equal((await deleteFile(app, src.token, 'mine')).statusCode, 200);
    assert.equal((await deleteFile(app, src.token, 'mine')).statusCode, 200);
    assert.equal((await events(w, 'source.item_deleted')).length, 1);
  });

  test('DELETE still works after a person moved the file out and the target space was archived', async () => {
    const { w } = await setup();
    const roomy = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: w.ownerHeaders, payload: { name: 'Roomy', slug: 'roomy', review_required: false } });
    const feed = await makeSource(app, w.ownerHeaders, { name: 'Roomy feed', spaceId: roomy.json().id });
    await putFile(app, feed.token, 'nomad', { name: 'n.pdf', data: pdf('nomad file text') });
    const doc = await docOf(w, 'nomad');
    const moved = await app.inject({ method: 'POST', url: `/api/v1/files/${doc.id}/move`, headers: w.ownerHeaders, payload: { target_space_id: w.open.id } });
    assert.equal(moved.statusCode, 200, moved.body);
    const archived = await app.inject({ method: 'POST', url: `/api/v1/spaces/${roomy.json().id}/archive`, headers: w.ownerHeaders });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal((await deleteFile(app, feed.token, 'nomad')).statusCode, 200);
    assert.ok((await docOf(w, 'nomad')).sourceDeletedAt);
  });

  test('DELETE while the file is still being read: the worker must not bring it back', async () => {
    const { w, src } = await setup();
    const res = await putFile(app, src.token, 'busy', { name: 'busy.pdf', data: pdf('quokka extraction race') });
    const id = res.json().document.id as string;
    assert.equal((await deleteFile(app, src.token, 'busy')).statusCode, 200);
    await settle(w.tenant.id);
    assert.deepEqual((await versionsOf(w, id)).map((v) => v.status), ['withdrawn']);
    assert.equal(await chunkCount(w, id), 0);
    assert.equal((await search(w, 'quokka extraction race')).length, 0);
  });

  test('DELETE while the version is queued for indexing: the job must not index it', async () => {
    const { w, src } = await setup();
    const res = await putFile(app, src.token, 'queued', { name: 'q.pdf', data: pdf('numbat indexing race') });
    const id = res.json().document.id as string;
    await settle(w.tenant.id);
    await approveWaiting(w, id); // now `indexing`, its job queued
    assert.deepEqual((await versionsOf(w, id)).map((v) => v.status), ['indexing']);
    assert.equal((await deleteFile(app, src.token, 'queued')).statusCode, 200);
    await settle(w.tenant.id);
    assert.deepEqual((await versionsOf(w, id)).map((v) => v.status), ['withdrawn']);
    assert.equal(await chunkCount(w, id), 0);
    assert.equal((await search(w, 'numbat indexing race')).length, 0);
  });

  test('DELETE of a file waiting for review withdraws it and empties the review queue', async () => {
    const { w, src } = await setup();
    const res = await putFile(app, src.token, 'waiting', { name: 'w.pdf', data: pdf('ibex waiting text') });
    await settle(w.tenant.id);
    const queue = async () => (await app.inject({ method: 'GET', url: '/api/v1/reviews', headers: w.ownerHeaders })).json() as unknown[];
    assert.equal((await queue()).length, 1);
    assert.equal((await deleteFile(app, src.token, 'waiting')).statusCode, 200);
    assert.equal((await queue()).length, 0);
    assert.deepEqual((await versionsOf(w, res.json().document.id)).map((v) => v.status), ['withdrawn']);
  });

  test('a PUT after DELETE revives the file with a new version, even with identical bytes', async () => {
    const { w, src } = await setup();
    const file = { name: 'back.pdf', data: pdf('the same bytes before and after') };
    const first = await putFile(app, src.token, 'back', file);
    const id = first.json().document.id as string;
    await deleteFile(app, src.token, 'back');
    const again = await putFile(app, src.token, 'back', file);
    assert.equal(again.statusCode, 201, again.body);
    assert.deepEqual([again.json().created, again.json().unchanged, again.json().version.number, again.json().document.id], [false, false, 2, id]);
    const doc = await docOf(w, 'back');
    assert.equal(doc.sourceDeletedAt, null);
    assert.equal((await itemOf(w, id)).deletedAt, null);
    assert.notEqual((await details(w, id)).badge, 'Removed at source');
    await settle(w.tenant.id);
    await approveWaiting(w, id);
    await settle(w.tenant.id);
    assert.equal((await search(w, 'same bytes before and after')).filter((p) => p.documentId === id).length, 1);
  });

  test('a PUT after dismiss or after an admin archived the removed file lifts the archive', async () => {
    const { w, src } = await setup();
    for (const how of ['dismiss', 'archive'] as const) {
      const ext = `lift-${how}`;
      const id = (await putFile(app, src.token, ext, { name: `${ext}.pdf`, data: pdf(`first ${how} text`) })).json().document.id as string;
      await deleteFile(app, src.token, ext);
      const gone = how === 'dismiss'
        ? await dismiss(w.editor.headers, id)
        : await app.inject({ method: 'POST', url: `/api/v1/files/${id}/archive`, headers: w.ownerHeaders });
      assert.equal(gone.statusCode, 200, gone.body);
      assert.ok((await docOf(w, ext)).archivedAt);
      const back = await putFile(app, src.token, ext, { name: `${ext}.pdf`, data: pdf(`second ${how} text`) });
      assert.equal(back.statusCode, 201, back.body);
      const doc = await docOf(w, ext);
      assert.deepEqual([doc.archivedAt, doc.sourceDeletedAt], [null, null]);
    }
  });

  test('a revive into an archived space is refused (409)', async () => {
    const { w } = await setup();
    const temp = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: w.ownerHeaders, payload: { name: 'Temp', slug: 'temp', review_required: false } });
    const feed = await makeSource(app, w.ownerHeaders, { name: 'Temp feed', spaceId: temp.json().id });
    const id = (await putFile(app, feed.token, 'e', { name: 'e.pdf', data: pdf('ephemeral text') })).json().document.id as string;
    await deleteFile(app, feed.token, 'e');
    assert.equal((await dismiss(w.ownerHeaders, id)).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/spaces/${temp.json().id}/archive`, headers: w.ownerHeaders })).statusCode, 200);
    const res = await putFile(app, feed.token, 'e', { name: 'e.pdf', data: pdf('ephemeral text again') });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'space_archived');
  });

  test('a pinned file that lost its source stays withdrawn and listed, and cannot be dismissed', async () => {
    const { w, src } = await setup();
    const id = await publish(w, src.token, 'pinned', 'pinned file text about lynx');
    const moved = await app.inject({ method: 'POST', url: `/api/v1/files/${id}/move`, headers: w.ownerHeaders, payload: { target_space_id: w.open.id } });
    assert.equal(moved.statusCode, 200, moved.body);
    await deleteFile(app, src.token, 'pinned');
    const d = await details(w, id);
    assert.ok(d.sourceDeletedAt);
    assert.equal(d.archivedAt, null);
    assert.equal(d.placement, 'pinned');
    const tree = await app.inject({ method: 'GET', url: `/api/v1/spaces/${w.open.id}/tree`, headers: w.ownerHeaders });
    assert.ok((tree.json().nodes as Array<{ id: string }>).some((n) => n.id === id));
    const res = await dismiss(w.editor.headers, id);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'not_removed');
  });

  test("a person's replacement of a pinned file that lost its source is kept, not withdrawn by the worker", async () => {
    const { w, src } = await setup();
    const id = await publish(w, src.token, 'takeover', 'takeover original dormouse text');
    await app.inject({ method: 'POST', url: `/api/v1/files/${id}/move`, headers: w.ownerHeaders, payload: { target_space_id: w.open.id } });
    await deleteFile(app, src.token, 'takeover');
    assert.ok((await docOf(w, 'takeover')).sourceDeletedAt);

    const replaced = await app.inject(uploadRequest(`/api/v1/files/${id}/versions`, w.editor.headers, { name: 'takeover.pdf', data: pdf('takeover corrected gerbil text') }));
    assert.equal(replaced.statusCode, 201, replaced.body);
    await settle(w.tenant.id); // a person's upload in a space without review needs no approval
    const latest = (await versionsOf(w, id)).at(-1)!;
    assert.equal(latest.status, 'indexed', `the person's version ended ${latest.status}`);
    assert.equal((await search(w, 'takeover corrected gerbil text')).filter((p) => p.documentId === id).length, 1);
    assert.equal((await docOf(w, 'takeover')).sourceDeletedAt, null, 'the person took the file over');

    // The source can still bring it back: new bytes are a new version.
    const back = await putFile(app, src.token, 'takeover', { name: 'takeover.pdf', data: pdf('takeover source again wombat text') });
    assert.equal(back.statusCode, 201, back.body);
    assert.equal((await itemOf(w, id)).deletedAt, null);
  });

  test('dismiss-removal: an editor archives a removed synced file; the other cases are refused', async () => {
    const { w, src } = await setup();
    const id = (await putFile(app, src.token, 'd', { name: 'd.pdf', data: pdf('dismiss me') })).json().document.id as string;
    // Not removed yet.
    const early = await dismiss(w.editor.headers, id);
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error, 'not_removed');
    await deleteFile(app, src.token, 'd');
    const viewer = await dismiss(w.viewer.headers, id);
    assert.equal(viewer.statusCode, 403, viewer.body);

    const done = await dismiss(w.editor.headers, id);
    assert.equal(done.statusCode, 200, done.body);
    assert.ok(done.json().archivedAt);
    const [event] = await events(w, 'file.archived');
    assert.equal(event!.actorId, w.editor.userId);
    const twice = await dismiss(w.editor.headers, id);
    assert.equal(twice.statusCode, 409);
    assert.equal(twice.json().error, 'not_removed');

    const page = await app.inject({ method: 'POST', url: '/api/v1/pages', headers: w.ownerHeaders, payload: { space_id: w.open.id, parent_id: null, title: 'A page', slug: 'a-page' } });
    const onPage = await dismiss(w.editor.headers, page.json().id);
    assert.equal(onPage.statusCode, 404);
    assert.equal(onPage.json().error, 'document_not_found');
  });

  test("dismiss-removal on another member's Inbox file is the same 404 as a missing one", async () => {
    const { w } = await setup();
    const other = await signUpMember(app, w.tenant.id, 'member');
    const up = await app.inject(uploadRequest('/api/v1/files', other.headers, { name: 'secret.txt', data: 'private inbox text' }));
    assert.equal(up.statusCode, 201, up.body);
    const hidden = await dismiss(w.editor.headers, up.json().document.id);
    const missing = await dismiss(w.editor.headers, '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b');
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.json().error, 'document_not_found');
    assert.equal(hidden.body, missing.body);
  });

  test('a simultaneous PUT and DELETE end in a consistent state', async () => {
    const { w, src } = await setup();
    for (let i = 0; i < 6; i++) {
      const ext = `race-${i}`;
      const id = (await putFile(app, src.token, ext, { name: `${ext}.pdf`, data: pdf(`race base ${i}`) })).json().document.id as string;
      await Promise.all([
        putFile(app, src.token, ext, { name: `${ext}.pdf`, data: pdf(`race changed ${i}`) }),
        deleteFile(app, src.token, ext),
      ]);
      await settle(w.tenant.id);
      const doc = await docOf(w, ext);
      const item = await itemOf(w, id);
      const live = (await versionsOf(w, id)).filter((v) => ['extracting', 'pending_review', 'indexing', 'indexed'].includes(v.status));
      assert.equal(doc.sourceDeletedAt === null, item.deletedAt === null, `${ext}: document and item disagree`);
      if (doc.sourceDeletedAt) assert.equal(live.length, 0, `${ext}: removed but still live`);
      else assert.ok(live.length >= 1, `${ext}: revived with nothing live`);
    }
  });
});
