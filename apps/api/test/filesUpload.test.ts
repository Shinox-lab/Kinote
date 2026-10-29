import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { auditEvents, documents, jobs, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { ERROR_SENTENCES } from '@kinote/contracts';
import { buildTestApp, bootstrapTenant, signUpMember, signUp, asUser, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';
import { replaceFile, uploadFile } from '../src/routes/files.js';

/** Counts how often bytes are stored, so a refused or repeated upload can be shown to write nothing. */
class CountingStorage extends InMemoryObjectStorage {
  puts: string[] = [];
  deletes: string[] = [];
  async put(tenantId: string, path: string, bytes: Uint8Array, mime: string) {
    const out = await super.put(tenantId, path, bytes, mime);
    this.puts.push(out.objectKey);
    return out;
  }
  async delete(tenantId: string, key: string) {
    this.deletes.push(key);
    return super.delete(tenantId, key);
  }
}

describe('uploading and replacing files', () => {
  let storage: CountingStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new CountingStorage();
    app = buildTestApp({ storage, maxUploadBytes: 1000 });
  });

  async function setup() {
    const { tenant, owner, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Files Co', slug: 'files-co' });
    const spaceRes = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: ownerHeaders,
      payload: { name: 'Docs', slug: 'docs', review_required: false },
    });
    assert.equal(spaceRes.statusCode, 201, spaceRes.body);
    const space = spaceRes.json();
    const editor = await signUpMember(app, tenant.id, 'member');
    const editor2 = await signUpMember(app, tenant.id, 'member');
    const viewer = await signUpMember(app, tenant.id, 'member');
    const outsider = await signUpMember(app, tenant.id, 'member');
    for (const [uid, role] of [
      [editor.userId, 'editor'],
      [editor2.userId, 'editor'],
      [viewer.userId, 'viewer'],
    ] as const) {
      const granted = await app.inject({
        method: 'POST',
        url: `/api/v1/spaces/${space.id}/grants`,
        headers: ownerHeaders,
        payload: { principal_type: 'user', principal_id: uid, role },
      });
      assert.equal(granted.statusCode, 201, granted.body);
    }
    return { tenant, owner, ownerHeaders, inboxSpace, space, editor, editor2, viewer, outsider };
  }

  const upload = (
    headers: Record<string, string>,
    file: { name: string; data: Uint8Array | string } | null,
    fields: Record<string, string> = {}
  ) => app.inject(uploadRequest('/api/v1/files', headers, file, fields));
  const replace = (headers: Record<string, string>, id: string, file: { name: string; data: Uint8Array | string } | null) =>
    app.inject(uploadRequest(`/api/v1/files/${id}/versions`, headers, file));

  const versionRows = (tenantId: string, documentId: string) =>
    withTenantTx(tenantId, (tx) =>
      tx.select().from(versions).where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, documentId))).orderBy(versions.number)
    );
  const documentRows = (tenantId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.kind, 'file'))));

  test('a member uploads a text file into a space: version extracting, bytes stored, job queued, audited', async () => {
    const { tenant, space, editor } = await setup();
    const res = await upload(editor.headers, { name: 'notes.txt', data: 'hello' }, { space_id: space.id });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.unchanged, false);
    assert.equal(body.document.spaceId, space.id);
    assert.equal(body.document.title, 'notes.txt');
    assert.equal(body.version.number, 1);
    assert.equal(body.version.status, 'extracting');
    assert.equal(body.version.fileName, 'notes.txt');
    assert.equal(body.version.mimeType, 'text/plain');
    assert.equal(body.version.sizeBytes, 5);
    assert.equal(body.version.hasText, false);
    assert.equal(Object.keys(body.version).length, 16);

    const key = `${tenant.id}/files/${body.document.id}/${body.version.id}/original`;
    assert.deepEqual(storage.puts, [key]);
    assert.equal(new TextDecoder().decode((await storage.get(tenant.id, key)).bytes), 'hello');

    await withTenantTx(tenant.id, async (tx) => {
      const [job] = await tx.select().from(jobs).where(and(eq(jobs.tenantId, tenant.id), eq(jobs.queue, 'file.extract')));
      assert.equal(job!.idempotencyKey, `extract:${body.version.id}`);
      const events = await tx.select().from(auditEvents).where(eq(auditEvents.tenantId, tenant.id));
      const types = events.map((e) => e.type);
      assert.ok(types.includes('file.uploaded'));
      assert.ok(types.includes('version.created'));
    });
    const [row] = await versionRows(tenant.id, body.document.id);
    assert.equal(row!.objectKey, key);
  });

  test('without a space the file goes to the Inbox', async () => {
    const { inboxSpace, editor } = await setup();
    const res = await upload(editor.headers, { name: 'notes.txt', data: 'hello' });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().document.spaceId, inboxSpace.id);
  });

  test('the file name is cleaned: no path or control characters reach the title', async () => {
    const { tenant, space, editor } = await setup();
    // The multipart parser already drops the directory part of a filename.
    const res = await upload(editor.headers, { name: '../../x\ty.txt', data: 'hello' }, { space_id: space.id });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().document.title, 'x y.txt');
    // Called directly (a script, not a browser), the name still never keeps a separator.
    const actor = { tenantId: tenant.id, principalType: 'user' as const, principalId: editor.userId, tenantRole: 'member' as const };
    const direct = await uploadFile(actor, { fields: { space_id: space.id }, file: { name: '..\\..\\y\u0000.txt', bytes: new TextEncoder().encode('direct') } }, { storage });
    assert.equal(direct.response.document.title, '.._.._y.txt');
  });

  test('the same bytes again in the same space answer unchanged and write nothing', async () => {
    const { tenant, space, editor, editor2 } = await setup();
    const first = await upload(editor.headers, { name: 'notes.txt', data: 'same bytes' }, { space_id: space.id });
    assert.equal(first.statusCode, 201);
    const putsBefore = storage.puts.length;
    const again = await upload(editor2.headers, { name: 'copy.txt', data: 'same bytes' }, { space_id: space.id });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().unchanged, true);
    assert.equal(again.json().document.id, first.json().document.id);
    assert.equal(again.json().version.id, first.json().version.id);
    assert.equal(storage.puts.length, putsBefore);
    assert.equal((await documentRows(tenant.id)).length, 1);
  });

  test('Inbox: a second member uploading the same bytes gets their own file and learns nothing of the first', async () => {
    const { tenant, inboxSpace, editor, editor2 } = await setup();
    const a = await upload(editor.headers, { name: 'secret.txt', data: 'inbox bytes' });
    const b = await upload(editor2.headers, { name: 'secret.txt', data: 'inbox bytes' });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201, b.body);
    assert.equal(b.json().unchanged, false);
    assert.notEqual(b.json().document.id, a.json().document.id);
    const again = await upload(editor.headers, { name: 'secret.txt', data: 'inbox bytes' });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().document.id, a.json().document.id);
    const tree = await app.inject({ method: 'GET', url: `/api/v1/spaces/${inboxSpace.id}/tree`, headers: editor2.headers });
    assert.deepEqual(tree.json().nodes.map((n: { id: string }) => n.id), [b.json().document.id]);
    assert.equal((await documentRows(tenant.id)).length, 2);
  });

  test('a viewer cannot upload (403) and a member without access to the space sees it as missing (404)', async () => {
    const { space, viewer, outsider } = await setup();
    const asViewer = await upload(viewer.headers, { name: 'a.txt', data: 'x' }, { space_id: space.id });
    assert.equal(asViewer.statusCode, 403);
    const asOutsider = await upload(outsider.headers, { name: 'a.txt', data: 'x' }, { space_id: space.id });
    assert.equal(asOutsider.statusCode, 404);
    assert.equal(asOutsider.json().error, 'space_not_found');
    assert.deepEqual(storage.puts, []);
  });

  test('HTML, SVG and mismatched files are refused with 415 and store nothing', async () => {
    const { space, editor } = await setup();
    for (const [name, data] of [
      ['x.png', '<!DOCTYPE html><p>hi</p>'],
      ['x.txt', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['x.svg', '<svg/>'],
      ['x.docx', 'not a zip'],
      ['x.exe', 'MZ'],
    ] as const) {
      const res = await upload(editor.headers, { name, data }, { space_id: space.id });
      assert.equal(res.statusCode, 415, `${name}: ${res.body}`);
      assert.equal(res.json().error, 'unsupported_file_type');
      assert.equal(res.json().message, ERROR_SENTENCES.unsupported_file_type);
    }
    assert.deepEqual(storage.puts, []);
  });

  test('an empty file is 400 empty_file', async () => {
    const { space, editor } = await setup();
    const res = await upload(editor.headers, { name: 'a.txt', data: '' }, { space_id: space.id });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'empty_file');
  });

  test('exactly the size limit is accepted and one byte more is 413 file_too_large', async () => {
    const { space, editor } = await setup();
    const ok = await upload(editor.headers, { name: 'a.txt', data: 'a'.repeat(1000) }, { space_id: space.id });
    assert.equal(ok.statusCode, 201, ok.body);
    const big = await upload(editor.headers, { name: 'b.txt', data: 'b'.repeat(1001) }, { space_id: space.id });
    assert.equal(big.statusCode, 413);
    assert.equal(big.json().error, 'file_too_large');
    assert.equal(storage.puts.length, 1);
  });

  test('a request with no file part, or two, or not multipart, is 400 validation_failed', async () => {
    const { space, editor } = await setup();
    const none = await upload(editor.headers, null, { space_id: space.id });
    assert.equal(none.statusCode, 400);
    assert.equal(none.json().error, 'validation_failed');
    const json = await app.inject({ method: 'POST', url: '/api/v1/files', headers: editor.headers, payload: { a: 1 } });
    assert.equal(json.statusCode, 400);
    assert.equal(json.json().error, 'validation_failed');
    const bad = await upload(editor.headers, { name: 'a.txt', data: 'x' }, { space_id: 'not-a-uuid' });
    assert.equal(bad.statusCode, 400);
  });

  test('a file can sit under a page of the same space, but not under a file or a page elsewhere', async () => {
    const { space, ownerHeaders, editor } = await setup();
    const pageRes = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: editor.headers,
      payload: { space_id: space.id, title: 'Parent', slug: 'parent', markdown: 'text' },
    });
    assert.equal(pageRes.statusCode, 201, pageRes.body);
    const ok = await upload(editor.headers, { name: 'a.txt', data: 'under a page' }, { space_id: space.id, parent_id: pageRes.json().id });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal(ok.json().document.parentId, pageRes.json().id);

    const underFile = await upload(editor.headers, { name: 'b.txt', data: 'under a file' }, { space_id: space.id, parent_id: ok.json().document.id });
    assert.equal(underFile.statusCode, 404);
    assert.equal(underFile.json().error, 'parent_not_found');

    const otherSpace = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name: 'Other', slug: 'other' } });
    const elsewhere = await upload(ownerHeaders, { name: 'c.txt', data: 'elsewhere' }, { space_id: otherSpace.json().id, parent_id: pageRes.json().id });
    assert.equal(elsewhere.statusCode, 404);
    assert.equal(elsewhere.json().error, 'parent_not_found');
  });

  test('replacing a file adds version 2 and supersedes a version still waiting for review', async () => {
    const { tenant, space, editor } = await setup();
    const first = await upload(editor.headers, { name: 'notes.txt', data: 'one' }, { space_id: space.id });
    await withTenantTx(tenant.id, (tx) => tx.update(versions).set({ status: 'pending_review' }).where(eq(versions.id, first.json().version.id)));
    const second = await replace(editor.headers, first.json().document.id, { name: 'notes-v2.txt', data: 'two' });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(second.json().version.number, 2);
    assert.equal(second.json().unchanged, false);
    assert.deepEqual((await versionRows(tenant.id, first.json().document.id)).map((v) => v.status), ['superseded', 'extracting']);
    assert.equal(second.json().document.id, first.json().document.id);
  });

  test('replacing with the same bytes is unchanged; a withdrawn latest version does not count', async () => {
    const { tenant, space, editor } = await setup();
    const first = await upload(editor.headers, { name: 'notes.txt', data: 'one' }, { space_id: space.id });
    const same = await replace(editor.headers, first.json().document.id, { name: 'notes.txt', data: 'one' });
    assert.equal(same.statusCode, 200, same.body);
    assert.equal(same.json().unchanged, true);
    await withTenantTx(tenant.id, (tx) => tx.update(versions).set({ status: 'withdrawn' }).where(eq(versions.id, first.json().version.id)));
    const again = await replace(editor.headers, first.json().document.id, { name: 'notes.txt', data: 'one' });
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(again.json().version.number, 2);
  });

  test('replace refuses a synced file (409 managed_by_source), an archived file (409) and another tenant\'s file (404)', async () => {
    const { tenant, space, editor } = await setup();
    const file = await upload(editor.headers, { name: 'notes.txt', data: 'one' }, { space_id: space.id });
    const id: string = file.json().document.id;

    await withTenantTx(tenant.id, (tx) => tx.update(documents).set({ placement: 'synced' }).where(eq(documents.id, id)));
    const synced = await replace(editor.headers, id, { name: 'n.txt', data: 'two' });
    assert.equal(synced.statusCode, 409);
    assert.equal(synced.json().error, 'managed_by_source');

    await withTenantTx(tenant.id, (tx) => tx.update(documents).set({ placement: 'pinned', archivedAt: new Date() }).where(eq(documents.id, id)));
    const archived = await replace(editor.headers, id, { name: 'n.txt', data: 'three' });
    assert.equal(archived.statusCode, 409);
    assert.equal(archived.json().error, 'page_archived');
    assert.match(archived.json().message, /file/);

    const stranger = await signUp(app);
    const other = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co', email: 'other-owner@example.test' });
    const crossTenant = await replace(other.headers, id, { name: 'n.txt', data: 'four' });
    assert.equal(crossTenant.statusCode, 404);
    assert.equal(crossTenant.json().error, 'document_not_found');
    const noRole = await replace(asUser(stranger, tenant.id), id, { name: 'n.txt', data: 'five' });
    assert.ok([401, 403, 404].includes(noRole.statusCode));
  });

  test('a page id on a file route is 404, and a viewer cannot replace', async () => {
    const { space, editor, viewer } = await setup();
    const pageRes = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: editor.headers,
      payload: { space_id: space.id, title: 'P', slug: 'p', markdown: 'text' },
    });
    const onPage = await replace(editor.headers, pageRes.json().id, { name: 'n.txt', data: 'x' });
    assert.equal(onPage.statusCode, 404);
    const file = await upload(editor.headers, { name: 'notes.txt', data: 'one' }, { space_id: space.id });
    const asViewer = await replace(viewer.headers, file.json().document.id, { name: 'n.txt', data: 'two' });
    assert.equal(asViewer.statusCode, 403);
  });

  test('two uploads of the same bytes at once make one file', async () => {
    const { tenant, space, editor, editor2 } = await setup();
    const [a, b] = await Promise.all([
      upload(editor.headers, { name: 'race.txt', data: 'race bytes' }, { space_id: space.id }),
      upload(editor2.headers, { name: 'race.txt', data: 'race bytes' }, { space_id: space.id }),
    ]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201]);
    assert.equal(a.json().document.id, b.json().document.id);
    assert.equal((await documentRows(tenant.id)).length, 1);
    assert.equal((await versionRows(tenant.id, a.json().document.id)).length, 1);
  });

  test('a failure after the bytes were stored deletes them', async () => {
    const { tenant, space, editor } = await setup();
    const actor = { tenantId: tenant.id, principalType: 'user' as const, principalId: editor.userId, tenantRole: 'member' as const };
    await assert.rejects(
      uploadFile(
        actor,
        { fields: { space_id: space.id }, file: { name: 'a.txt', bytes: new TextEncoder().encode('doomed') } },
        {
          storage,
          afterStore: async () => {
            throw new Error('boom');
          },
        }
      ),
      /boom/
    );
    assert.equal(storage.puts.length, 1);
    assert.deepEqual(storage.deletes, storage.puts);
    assert.equal((await documentRows(tenant.id)).length, 0);

    const file = await upload(editor.headers, { name: 'ok.txt', data: 'fine' }, { space_id: space.id });
    const before = storage.puts.length;
    await assert.rejects(
      replaceFile(actor, file.json().document.id, { name: 'ok2.txt', bytes: new TextEncoder().encode('doomed again') }, {
        storage,
        afterStore: async () => {
          throw new Error('boom');
        },
      }),
      /boom/
    );
    assert.equal(storage.puts.length, before + 1);
    assert.equal(storage.deletes.at(-1), storage.puts.at(-1));
  });
});
