import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { chunks, versions, withTenantTx } from '@living-wiki/db';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor } from '@living-wiki/core';
import {
  ChunkInspectorSchema,
  FileDetailsSchema,
  FileVersionListSchema,
  ERROR_SENTENCES,
  VersionTextSchema,
} from '@living-wiki/contracts';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';
import { randomUUID } from 'node:crypto';

describe('reading files', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });
  const settle = (tenantId: string) => runPendingJobsForTenant(tenantId, { storage, extractor: new FakeExtractor() });

  async function setup() {
    const { tenant, inboxSpace, owner, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Read Co', slug: 'read-co' });
    const mk = async (name: string, review: boolean) =>
      (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name, slug: name.toLowerCase(), review_required: review } })).json();
    const open = await mk('Open', false);
    const strict = await mk('Strict', true);
    const author = await signUpMember(app, tenant.id, 'member', 'author@example.test');
    const viewer = await signUpMember(app, tenant.id, 'member');
    const reviewer = await signUpMember(app, tenant.id, 'member');
    const outsider = await signUpMember(app, tenant.id, 'member');
    for (const [space, user, role] of [
      [open, author, 'editor'], [strict, author, 'editor'], [open, viewer, 'viewer'], [strict, reviewer, 'reviewer'],
    ] as const) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/spaces/${space.id}/grants`, headers: ownerHeaders,
        payload: { principal_type: 'user', principal_id: user.userId, role },
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    return { tenant, owner, inboxSpace, ownerHeaders, open, strict, author, viewer, reviewer, outsider };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function upload(headers: Record<string, string>, spaceId: string | undefined, name: string, data: string | Uint8Array) {
    const res = await app.inject(uploadRequest('/api/v1/files', headers, { name, data }, spaceId ? { space_id: spaceId } : {}));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  }
  const get = (headers: Record<string, string>, url: string) => app.inject({ method: 'GET', url, headers });

  test('details: badge, latest and indexed versions, shape fixed by the contract', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.open.id, 'policy.txt', 'Remote work is allowed.');
    const before = await get(c.viewer.headers, `/api/v1/files/${up.document.id}`);
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().badge, 'Reading text…');
    assert.equal(before.json().indexedVersion, null);

    await settle(c.tenant.id);
    const res = await get(c.viewer.headers, `/api/v1/files/${up.document.id}`);
    const body = FileDetailsSchema.parse(res.json());
    assert.equal(body.badge, 'Indexed · v1');
    assert.equal(body.title, 'policy.txt');
    assert.equal(body.placement, 'pinned');
    assert.equal(body.sourceDeletedAt, null);
    assert.equal(body.latestVersion?.id, up.version.id);
    assert.equal(body.indexedVersion?.id, up.version.id);
    assert.equal(body.indexedVersion?.hasText, true);
    assert.deepEqual(Object.keys(body).sort(), ['archivedAt', 'badge', 'id', 'indexedVersion', 'latestVersion', 'parentId', 'placement', 'sourceDeletedAt', 'spaceId', 'title']);
  });

  test('a file nobody here may see is a plain 404 on every read route, whoever asks', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.open.id, 'policy.txt', 'Remote work is allowed.');
    await settle(c.tenant.id);
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co', email: 'other@example.test' });
    for (const headers of [c.outsider.headers, other.headers]) {
      for (const url of [
        `/api/v1/files/${up.document.id}`,
        `/api/v1/files/${up.document.id}/versions`,
        `/api/v1/versions/${up.version.id}/file`,
        `/api/v1/versions/${up.version.id}/chunks`,
      ]) {
        const res = await get(headers, url);
        assert.equal(res.statusCode, 404, `${url}: ${res.body}`);
      }
    }
    assert.equal((await get(c.author.headers, '/api/v1/files/not-a-uuid')).statusCode, 404);
    assert.equal((await get(c.author.headers, '/api/v1/versions/not-a-uuid/file')).statusCode, 404);
  });

  test('an Inbox file is the creator\'s and the admin\'s alone', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, undefined, 'mine.txt', 'private notes');
    await settle(c.tenant.id);
    for (const url of [`/api/v1/files/${up.document.id}`, `/api/v1/versions/${up.version.id}/file`]) {
      assert.equal((await get(c.outsider.headers, url)).statusCode, 404);
      assert.equal((await get(c.author.headers, url)).statusCode, 200);
      assert.equal((await get(c.ownerHeaders, url)).statusCode, 200);
    }
  });

  test('a page id on a file route, and a file version on a page route, are 404', async () => {
    const c = await setup();
    const page = await app.inject({
      method: 'POST', url: '/api/v1/pages', headers: c.author.headers,
      payload: { space_id: c.open.id, title: 'P', slug: 'p', markdown: 'text' },
    });
    assert.equal((await get(c.author.headers, `/api/v1/files/${page.json().id}`)).statusCode, 404);
    const up = await upload(c.author.headers, c.open.id, 'policy.txt', 'Remote work.');
    assert.equal((await get(c.author.headers, `/api/v1/pages/${up.document.id}`)).statusCode, 404);
    assert.equal((await get(c.author.headers, `/api/v1/versions/${up.version.id}`)).statusCode, 404);
    const snap = await app.inject({ method: 'POST', url: `/api/v1/pages/${page.json().id}/snapshot`, headers: c.author.headers });
    assert.equal((await get(c.author.headers, `/api/v1/versions/${snap.json().id}/file`)).statusCode, 404);
    assert.equal((await get(c.author.headers, `/api/v1/versions/${snap.json().id}/chunks`)).statusCode, 404);
  });

  test('history lists versions newest first with who made them; a script shows as System', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.open.id, 'policy.txt', 'first version text');
    const second = await app.inject(uploadRequest(`/api/v1/files/${up.document.id}/versions`, c.author.headers, { name: 'policy.txt', data: 'second version text' }));
    assert.equal(second.statusCode, 201, second.body);
    await withTenantTx(c.tenant.id, (tx) =>
      tx.update(versions).set({ createdByType: 'connector' }).where(eq(versions.id, second.json().version.id))
    );
    const res = await get(c.viewer.headers, `/api/v1/files/${up.document.id}/versions`);
    assert.equal(res.statusCode, 200, res.body);
    const list = FileVersionListSchema.parse(res.json());
    assert.deepEqual(list.map((v) => [v.number, v.createdByName]), [[2, 'System'], [1, 'author']]);
  });

  test('download returns the exact bytes with the safe headers', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.open.id, 'ü report (final).md', '# Title\n\nbody <script>alert(1)</script>');
    await settle(c.tenant.id); // a viewer reads only what has been published
    const res = await get(c.viewer.headers, `/api/v1/versions/${up.version.id}/file`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, '# Title\n\nbody <script>alert(1)</script>');
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-security-policy'], 'sandbox');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-disposition'], "attachment; filename*=UTF-8''%C3%BC%20report%20%28final%29.md");
  });

  test('a name with quotes or an apostrophe never reaches the header raw', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.open.id, 'a.txt', 'x');
    await withTenantTx(c.tenant.id, (tx) => tx.update(versions).set({ fileName: 'a"b\'c*.txt' }).where(eq(versions.id, up.version.id)));
    const res = await get(c.author.headers, `/api/v1/versions/${up.version.id}/file`);
    const disposition = String(res.headers['content-disposition']);
    assert.equal(disposition, "attachment; filename*=UTF-8''a%22b%27c%2A.txt");
    assert.ok(!disposition.includes('"'));
  });

  test('inline is honoured for an image and ignored for a PDF', async () => {
    const c = await setup();
    const png = await upload(c.author.headers, c.open.id, 'pic.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const pdf = await upload(c.author.headers, c.open.id, 'a.pdf', '%PDF-1.7\nFAKE-EXTRACT\ntext');
    const inline = await get(c.author.headers, `/api/v1/versions/${png.version.id}/file?inline=1`);
    assert.equal(inline.headers['content-type'], 'image/png');
    assert.match(String(inline.headers['content-disposition']), /^inline/);
    assert.match(String((await get(c.author.headers, `/api/v1/versions/${png.version.id}/file`)).headers['content-disposition']), /^attachment/);
    const pdfInline = await get(c.author.headers, `/api/v1/versions/${pdf.version.id}/file?inline=1`);
    assert.equal(pdfInline.headers['content-type'], 'application/pdf');
    assert.match(String(pdfInline.headers['content-disposition']), /^attachment/);
  });

  test('chunk inspector: editors only; not ready while the text is read; unindexed chunks are what indexing later stores', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.strict.id, 'contract.txt', 'The contract renews each year.\n\nNotice is thirty days.');
    const notReady = await get(c.author.headers, `/api/v1/versions/${up.version.id}/chunks`);
    assert.equal(notReady.statusCode, 200, notReady.body);
    assert.deepEqual(
      { ready: notReady.json().ready, indexed: notReady.json().indexed, chunks: notReady.json().chunks, sections: notReady.json().sections },
      { ready: false, indexed: false, chunks: [], sections: [] }
    );

    await settle(c.tenant.id);
    const viewerRes = await get(c.reviewer.headers, `/api/v1/versions/${up.version.id}/chunks`);
    assert.equal(viewerRes.statusCode, 200, 'a reviewer is above editor');
    const preview = ChunkInspectorSchema.parse((await get(c.author.headers, `/api/v1/versions/${up.version.id}/chunks`)).json());
    assert.equal(preview.ready, true);
    assert.equal(preview.indexed, false);
    assert.ok(preview.chunks.length > 0);
    assert.deepEqual(preview.sections.map((s) => s.kind), ['text']);

    const approved = await app.inject({ method: 'POST', url: `/api/v1/versions/${up.version.id}/approve`, headers: c.reviewer.headers, payload: {} });
    assert.equal(approved.statusCode, 200, approved.body);
    await settle(c.tenant.id);
    const stored = await withTenantTx(c.tenant.id, (tx) =>
      tx.select().from(chunks).where(and(eq(chunks.tenantId, c.tenant.id), eq(chunks.versionId, up.version.id))).orderBy(chunks.ordinal)
    );
    const after = ChunkInspectorSchema.parse((await get(c.author.headers, `/api/v1/versions/${up.version.id}/chunks`)).json());
    assert.equal(after.indexed, true);
    assert.deepEqual(after.chunks.map((x) => x.text), preview.chunks.map((x) => x.text));
    assert.deepEqual(stored.map((x) => x.text), preview.chunks.map((x) => x.text));
  });

  test('a viewer cannot open the chunk inspector (403)', async () => {
    const c = await setup();
    const up = await upload(c.author.headers, c.open.id, 'policy.txt', 'Remote work is allowed.');
    await settle(c.tenant.id);
    assert.equal((await get(c.viewer.headers, `/api/v1/versions/${up.version.id}/chunks`)).statusCode, 403);
  });

  describe('what a viewer may read: the published version only', () => {
    const NOT_FOUND = { error: 'version_not_found', message: ERROR_SENTENCES.version_not_found };

    /** v1 published; v2 uploaded after it (still being read). */
    async function publishedThenNewer(c: Ctx) {
      const v1 = await upload(c.author.headers, c.open.id, 'policy.txt', 'The published policy text.');
      await settle(c.tenant.id);
      const second = await app.inject(uploadRequest(`/api/v1/files/${v1.document.id}/versions`, c.author.headers, { name: 'policy.txt', data: 'The newer unreviewed text.' }));
      assert.equal(second.statusCode, 201, second.body);
      return { documentId: v1.document.id, v1: v1.version.id, v2: second.json().version.id as string };
    }

    test('bytes and text of any other version are 404 for a viewer, whatever its status', async () => {
      const c = await setup();
      const { v1, v2 } = await publishedThenNewer(c);
      const unknown = await get(c.viewer.headers, `/api/v1/versions/${randomUUID()}/file`);
      for (const status of ['extracting', 'pending_review', 'rejected', 'withdrawn', 'superseded', 'stored', 'failed'] as const) {
        await withTenantTx(c.tenant.id, (tx) => tx.update(versions).set({ status }).where(eq(versions.id, v2)));
        for (const route of ['file', 'text']) {
          const res = await get(c.viewer.headers, `/api/v1/versions/${v2}/${route}`);
          assert.equal(res.statusCode, 404, `${status} ${route}: ${res.body}`);
          assert.deepEqual(res.json(), NOT_FOUND);
          assert.equal(res.body, (await get(c.viewer.headers, `/api/v1/versions/${randomUUID()}/${route}`)).body);
        }
      }
      assert.equal(unknown.statusCode, 404);
      assert.equal((await get(c.viewer.headers, `/api/v1/versions/${v1}/file`)).body, 'The published policy text.');
    });

    test('an editor and a tenant admin read every version', async () => {
      const c = await setup();
      const { v2 } = await publishedThenNewer(c);
      for (const headers of [c.author.headers, c.ownerHeaders]) {
        assert.equal((await get(headers, `/api/v1/versions/${v2}/file`)).body, 'The newer unreviewed text.');
        assert.equal((await get(headers, `/api/v1/versions/${v2}/text`)).statusCode, 200);
      }
    });

    test('a viewer reads the newer version once it is the published one, and no longer the old one', async () => {
      const c = await setup();
      const { v1, v2 } = await publishedThenNewer(c);
      await settle(c.tenant.id);
      assert.equal((await get(c.viewer.headers, `/api/v1/versions/${v2}/file`)).body, 'The newer unreviewed text.');
      assert.equal((await get(c.viewer.headers, `/api/v1/versions/${v1}/file`)).statusCode, 404);
    });

    test('the text route returns the extracted sections; not yet read is empty for an editor', async () => {
      const c = await setup();
      const up = await upload(c.author.headers, c.open.id, 'notes.txt', 'First paragraph.\n\nSecond paragraph.');
      const early = await get(c.author.headers, `/api/v1/versions/${up.version.id}/text`);
      assert.deepEqual(VersionTextSchema.parse(early.json()), { versionId: up.version.id, pageCount: null, ocrUsed: false, sections: [] });
      await settle(c.tenant.id);
      const text = VersionTextSchema.parse((await get(c.viewer.headers, `/api/v1/versions/${up.version.id}/text`)).json());
      assert.equal(text.versionId, up.version.id);
      assert.equal(text.sections.map((x) => x.text).join('\n\n'), 'First paragraph.\n\nSecond paragraph.');
      assert.equal('chunks' in text, false);
    });

    test("another member's Inbox file is 404 on both routes, for a viewer elsewhere and for an editor", async () => {
      const c = await setup();
      const up = await upload(c.author.headers, undefined, 'private.txt', 'My private inbox text.');
      await settle(c.tenant.id);
      for (const headers of [c.viewer.headers, c.reviewer.headers]) {
        for (const route of ['file', 'text']) {
          assert.equal((await get(headers, `/api/v1/versions/${up.version.id}/${route}`)).statusCode, 404);
        }
      }
    });
  });
});
