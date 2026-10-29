import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { chunks, documents, jobs, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor, type Extractor } from '@kinote/core';
import { AppError } from '@kinote/contracts';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

describe('file lifecycle', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  let extractor: Extractor;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
    extractor = new FakeExtractor();
  });

  const settle = (tenantId: string, clock?: () => Date) =>
    runPendingJobsForTenant(tenantId, { storage, extractor, clock });

  async function setup() {
    const { tenant, owner, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Life Co', slug: 'life-co' });
    const mkSpace = async (name: string, review: boolean) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/spaces',
        headers: ownerHeaders,
        payload: { name, slug: name.toLowerCase(), review_required: review },
      });
      assert.equal(res.statusCode, 201, res.body);
      return res.json();
    };
    const docs = await mkSpace('Docs', false);
    const more = await mkSpace('More', false);
    const strict = await mkSpace('Strict', true);
    const editor = await signUpMember(app, tenant.id, 'member');
    const editor2 = await signUpMember(app, tenant.id, 'member');
    const reviewer = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'member');
    const grant = async (spaceId: string, userId: string, role: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/spaces/${spaceId}/grants`,
        headers: ownerHeaders,
        payload: { principal_type: 'user', principal_id: userId, role },
      });
      assert.equal(res.statusCode, 201, res.body);
    };
    for (const space of [docs, more, strict]) {
      await grant(space.id, editor.userId, 'editor');
      await grant(space.id, editor2.userId, 'editor');
    }
    await grant(docs.id, reviewer.userId, 'reviewer');
    await grant(docs.id, viewer.userId, 'viewer');
    return { tenant, owner, ownerHeaders, inboxSpace, docs, more, strict, editor, editor2, reviewer, viewer };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function upload(headers: Record<string, string>, spaceId: string, name: string, data: string) {
    const res = await app.inject(uploadRequest('/api/v1/files', headers, { name, data }, { space_id: spaceId }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  }
  /** Uploads a text file and runs the worker until it is indexed. */
  async function indexedFile(c: Ctx, spaceId = c.docs.id, name = 'policy.txt', data = 'Remote work is allowed three days a week.') {
    const up = await upload(c.editor.headers, spaceId, name, data);
    await settle(c.tenant.id);
    return up;
  }
  const post = (headers: Record<string, string>, url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
  const docRow = (tenantId: string, id: string) =>
    withTenantTx(tenantId, async (tx) => (await tx.select().from(documents).where(eq(documents.id, id)))[0]!);
  const chunkRows = (tenantId: string, id: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(chunks).where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, id))));
  const versionRow = (tenantId: string, id: string) =>
    withTenantTx(tenantId, async (tx) => (await tx.select().from(versions).where(eq(versions.id, id)))[0]!);

  test('the upload is read and indexed by the worker (the lifecycle tests start here)', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    assert.equal((await versionRow(c.tenant.id, up.version.id)).status, 'indexed');
    assert.ok((await chunkRows(c.tenant.id, up.document.id)).length > 0);
    assert.equal((await docRow(c.tenant.id, up.document.id)).indexedVersionId, up.version.id);
  });

  test('moving within a space changes the parent and pins the file', async () => {
    const c = await setup();
    const page = await app.inject({
      method: 'POST', url: '/api/v1/pages', headers: c.editor.headers,
      payload: { space_id: c.docs.id, title: 'Parent', slug: 'parent', markdown: 'text' },
    });
    const up = await indexedFile(c);
    await withTenantTx(c.tenant.id, (tx) => tx.update(documents).set({ placement: 'synced' }).where(eq(documents.id, up.document.id)));
    const res = await post(c.editor.headers, `/api/v1/files/${up.document.id}/move`, {
      target_space_id: c.docs.id, target_parent_id: page.json().id, position: 'b0',
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().parentId, page.json().id);
    const row = await docRow(c.tenant.id, up.document.id);
    assert.equal(row.placement, 'pinned');
    assert.equal(row.parentId, page.json().id);
  });

  test('moving across spaces carries the chunks; into and out of the Inbox the owner follows', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    const id = up.document.id;
    let res = await post(c.editor.headers, `/api/v1/files/${id}/move`, { target_space_id: c.more.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await chunkRows(c.tenant.id, id)).every((r) => r.spaceId === c.more.id && r.inboxOwner === null));

    res = await post(c.editor.headers, `/api/v1/files/${id}/move`, { target_space_id: c.inboxSpace.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await chunkRows(c.tenant.id, id)).every((r) => r.spaceId === c.inboxSpace.id && r.inboxOwner === `user:${c.editor.userId}`));

    res = await post(c.editor.headers, `/api/v1/files/${id}/move`, { target_space_id: c.docs.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok((await chunkRows(c.tenant.id, id)).every((r) => r.spaceId === c.docs.id && r.inboxOwner === null));
  });

  test('only the creator may move a file into the Inbox, and a file cannot go under a file', async () => {
    const c = await setup();
    const a = await indexedFile(c);
    const b = await indexedFile(c, c.docs.id, 'other.txt', 'A different file with different words.');
    const notCreator = await post(c.editor2.headers, `/api/v1/files/${a.document.id}/move`, { target_space_id: c.inboxSpace.id });
    assert.equal(notCreator.statusCode, 403);
    const underFile = await post(c.editor.headers, `/api/v1/files/${a.document.id}/move`, {
      target_space_id: c.docs.id, target_parent_id: b.document.id,
    });
    assert.equal(underFile.statusCode, 404);
    assert.equal(underFile.json().error, 'parent_not_found');
  });

  test('moving into a review space sends the indexed version back to review and removes its chunks', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    const res = await post(c.editor.headers, `/api/v1/files/${up.document.id}/move`, { target_space_id: c.strict.id });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().indexedVersionId, null);
    assert.equal((await versionRow(c.tenant.id, up.version.id)).status, 'pending_review');
    assert.deepEqual(await chunkRows(c.tenant.id, up.document.id), []);
  });

  test('an unreadable target is 404, a viewer cannot move (403), a page route does not take a file', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    const outsider = await signUpMember(app, c.tenant.id, 'member');
    const hidden = await post(outsider.headers, `/api/v1/files/${up.document.id}/move`, { target_space_id: c.docs.id });
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.json().error, 'document_not_found');
    const viewer = await post(c.viewer.headers, `/api/v1/files/${up.document.id}/move`, { target_space_id: c.docs.id });
    assert.equal(viewer.statusCode, 403);
    const onPageRoute = await post(c.editor.headers, `/api/v1/pages/${up.document.id}/move`, { target_space_id: c.more.id });
    assert.equal(onPageRoute.statusCode, 404);
    const noSuchSpace = await post(c.editor.headers, `/api/v1/files/${up.document.id}/move`, {
      target_space_id: '00000000-0000-4000-8000-000000000000',
    });
    assert.equal(noSuchSpace.statusCode, 404);
  });

  test('withdraw (reviewer) empties the chunks at once; an editor cannot withdraw', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    const denied = await post(c.editor.headers, `/api/v1/files/${up.document.id}/withdraw`);
    assert.equal(denied.statusCode, 403);
    const res = await post(c.reviewer.headers, `/api/v1/files/${up.document.id}/withdraw`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().indexedVersionId, null);
    assert.equal((await versionRow(c.tenant.id, up.version.id)).status, 'withdrawn');
    assert.deepEqual(await chunkRows(c.tenant.id, up.document.id), []);
  });

  test('withdrawing while the text is still being read: the extract job later skips it', async () => {
    const c = await setup();
    const up = await upload(c.editor.headers, c.docs.id, 'late.txt', 'still extracting');
    const res = await post(c.reviewer.headers, `/api/v1/files/${up.document.id}/withdraw`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await versionRow(c.tenant.id, up.version.id)).status, 'withdrawn');
    await settle(c.tenant.id);
    assert.equal((await versionRow(c.tenant.id, up.version.id)).status, 'withdrawn');
    const indexJobs = await withTenantTx(c.tenant.id, (tx) =>
      tx.select().from(jobs).where(and(eq(jobs.tenantId, c.tenant.id), eq(jobs.queue, 'version.index')))
    );
    assert.deepEqual(indexJobs, []);
  });

  test('archive (space admin) removes it from the index; restore brings it back withdrawn', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    const denied = await post(c.editor.headers, `/api/v1/files/${up.document.id}/archive`);
    assert.equal(denied.statusCode, 403);
    const archived = await post(c.ownerHeaders, `/api/v1/files/${up.document.id}/archive`);
    assert.equal(archived.statusCode, 200, archived.body);
    assert.notEqual(archived.json().archivedAt, null);
    assert.deepEqual(await chunkRows(c.tenant.id, up.document.id), []);
    const replaceArchived = await app.inject(
      uploadRequest(`/api/v1/files/${up.document.id}/versions`, c.editor.headers, { name: 'n.txt', data: 'new' })
    );
    assert.equal(replaceArchived.statusCode, 409);

    const restored = await post(c.ownerHeaders, `/api/v1/files/${up.document.id}/restore`);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().archivedAt, null);
    assert.equal((await versionRow(c.tenant.id, up.version.id)).status, 'withdrawn');
    assert.deepEqual(await chunkRows(c.tenant.id, up.document.id), []);
  });

  test('restoring a file whose parent page was archived puts it at the top of the space', async () => {
    const c = await setup();
    const page = await app.inject({
      method: 'POST', url: '/api/v1/pages', headers: c.editor.headers,
      payload: { space_id: c.docs.id, title: 'Parent', slug: 'parent', markdown: 'text' },
    });
    const up = await upload(c.editor.headers, c.docs.id, 'child.txt', 'child text');
    await post(c.editor.headers, `/api/v1/files/${up.document.id}/move`, { target_space_id: c.docs.id, target_parent_id: page.json().id });
    await post(c.ownerHeaders, `/api/v1/files/${up.document.id}/archive`);
    const pageArchive = await post(c.ownerHeaders, `/api/v1/pages/${page.json().id}/archive`);
    assert.equal(pageArchive.statusCode, 200, pageArchive.body);
    const restored = await post(c.ownerHeaders, `/api/v1/files/${up.document.id}/restore`);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().parentId, null);
  });

  test('a page that holds a file cannot be archived', async () => {
    const c = await setup();
    const page = await app.inject({
      method: 'POST', url: '/api/v1/pages', headers: c.editor.headers,
      payload: { space_id: c.docs.id, title: 'Holder', slug: 'holder', markdown: 'text' },
    });
    const up = await upload(c.editor.headers, c.docs.id, 'inside.txt', 'inside text');
    await post(c.editor.headers, `/api/v1/files/${up.document.id}/move`, { target_space_id: c.docs.id, target_parent_id: page.json().id });
    const res = await post(c.ownerHeaders, `/api/v1/pages/${page.json().id}/archive`);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'has_children');
  });

  test('a version whose extraction failed is retried into extraction, then indexes once the extractor recovers', async () => {
    const c = await setup();
    let down = true;
    extractor = {
      extract: async (input) => {
        if (down) throw new AppError('extractor_unavailable');
        return new FakeExtractor().extract(input);
      },
    };
    const up = await upload(c.editor.headers, c.docs.id, 'scan.pdf', '%PDF-1.7\nFAKE-EXTRACT\nthe recovered scanned text');
    let t = Date.now();
    for (let i = 0; i < 20; i++) {
      await settle(c.tenant.id, () => new Date(t));
      const [job] = await withTenantTx(c.tenant.id, (tx) =>
        tx.select().from(jobs).where(and(eq(jobs.tenantId, c.tenant.id), eq(jobs.queue, 'file.extract')))
      );
      if (job!.status === 'dead_letter') break;
      t += (2 ** job!.attempts + 1) * 1000;
    }
    const failed = await versionRow(c.tenant.id, up.version.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.extractedKey, null);

    down = false;
    const viewer = await post(c.viewer.headers, `/api/v1/versions/${up.version.id}/retry`);
    assert.equal(viewer.statusCode, 403);
    const res = await post(c.editor.headers, `/api/v1/versions/${up.version.id}/retry`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'extracting');
    await settle(c.tenant.id);
    const done = await versionRow(c.tenant.id, up.version.id);
    assert.equal(done.status, 'indexed');
    assert.ok((await chunkRows(c.tenant.id, up.document.id)).some((r) => r.text.includes('recovered scanned text')));
  });

  test('a file version that failed while indexing is retried into indexing, not extraction', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    await withTenantTx(c.tenant.id, (tx) =>
      tx.update(versions).set({ status: 'failed', error: 'Indexing failed after 5 attempts: x' }).where(eq(versions.id, up.version.id))
    );
    const res = await post(c.editor.headers, `/api/v1/versions/${up.version.id}/retry`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'indexing');
    const job = await withTenantTx(c.tenant.id, (tx) =>
      tx.select().from(jobs).where(and(eq(jobs.tenantId, c.tenant.id), eq(jobs.queue, 'version.index')))
    );
    assert.equal(job.length, 1);
  });

  test('retrying a version of an archived file says so in words about a file', async () => {
    const c = await setup();
    const up = await indexedFile(c);
    await withTenantTx(c.tenant.id, (tx) =>
      tx.update(versions).set({ status: 'failed' }).where(eq(versions.id, up.version.id))
    );
    await post(c.ownerHeaders, `/api/v1/files/${up.document.id}/archive`);
    const res = await post(c.editor.headers, `/api/v1/versions/${up.version.id}/retry`);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'page_archived');
    assert.match(res.json().message, /file/);
  });
});
