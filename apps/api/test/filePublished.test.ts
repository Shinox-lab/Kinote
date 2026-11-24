import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { chunks, documents, versions, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor } from '@kinote/core';
import { FileDetailsSchema } from '@kinote/contracts';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';
import { uploadRequest } from './support/multipart.js';

const PNG_HEAD = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** A PNG the fake extractor finds no words in. */
const PNG_NO_TEXT = Buffer.concat([PNG_HEAD, Buffer.from('\nFAKE-EXTRACT-EMPTY\n')]);
const PDF_TEXT = '%PDF-1.7\nFAKE-EXTRACT\nThe quarterly zebra forecast.\n';

/** A file's published version: what a viewer may open, text or not. */
describe('published file versions', () => {
  let storage: InMemoryObjectStorage;
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    app = buildTestApp({ storage });
  });
  const settle = (tenantId: string) => runPendingJobsForTenant(tenantId, { storage, extractor: new FakeExtractor() });

  async function setup() {
    const { tenant, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Pub Co', slug: 'pub-co' });
    const open = (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name: 'Open', slug: 'open', review_required: false } })).json() as { id: string };
    const viewer = await signUpMember(app, tenant.id, 'member');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/spaces/${open.id}/grants`, headers: ownerHeaders,
      payload: { principal_type: 'user', principal_id: viewer.userId, role: 'viewer' },
    });
    assert.equal(res.statusCode, 201, res.body);
    return { tenant, ownerHeaders, open, viewer };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function upload(c: Ctx, name: string, data: string | Uint8Array) {
    const res = await app.inject(uploadRequest('/api/v1/files', c.ownerHeaders, { name, data }, { space_id: c.open.id }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { document: { id: string }; version: { id: string } };
  }
  async function replace(c: Ctx, fileId: string, name: string, data: string | Uint8Array) {
    const res = await app.inject(uploadRequest(`/api/v1/files/${fileId}/versions`, c.ownerHeaders, { name, data }));
    assert.equal(res.statusCode, 201, res.body);
    return res.json().version.id as string;
  }
  const get = (headers: Record<string, string>, url: string) => app.inject({ method: 'GET', url, headers });
  const doc = async (c: Ctx, id: string) => (await withTenantTx(c.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, id))))[0]!;
  const ver = async (c: Ctx, id: string) => (await withTenantTx(c.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.id, id))))[0]!;

  test('a viewer downloads the published stored image', async () => {
    const c = await setup();
    const up = await upload(c, 'photo.png', PNG_NO_TEXT);
    await settle(c.tenant.id);
    const v = await ver(c, up.version.id);
    assert.equal(v.status, 'stored');
    assert.equal(v.noText, true);
    assert.equal((await doc(c, up.document.id)).publishedVersionId, up.version.id);
    const res = await get(c.viewer.headers, `/api/v1/versions/${up.version.id}/file`);
    assert.equal(res.statusCode, 200, res.body);
    const details = FileDetailsSchema.parse((await get(c.viewer.headers, `/api/v1/files/${up.document.id}`)).json());
    assert.equal(details.publishedVersion?.id, up.version.id);
  });

  test('a viewer cannot read a newer unpublished version', async () => {
    const c = await setup();
    const up = await upload(c, 'photo.png', PNG_NO_TEXT);
    await settle(c.tenant.id);
    const v2 = await replace(c, up.document.id, 'photo.png', Buffer.concat([PNG_NO_TEXT, Buffer.from('v2')]));
    const res = await get(c.viewer.headers, `/api/v1/versions/${v2}/file`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'version_not_found');
    assert.equal((await get(c.viewer.headers, `/api/v1/versions/${up.version.id}/file`)).statusCode, 200);
  });

  test('publishing a no-text version removes the old text from search', async () => {
    const c = await setup();
    const up = await upload(c, 'report.pdf', PDF_TEXT);
    await settle(c.tenant.id);
    assert.equal((await doc(c, up.document.id)).indexedVersionId, up.version.id);
    const docChunks = () => withTenantTx(c.tenant.id, (tx) => tx.select().from(chunks).where(eq(chunks.documentId, up.document.id)));
    assert.ok((await docChunks()).length > 0);

    const v2 = await replace(c, up.document.id, 'report.png', PNG_NO_TEXT);
    await settle(c.tenant.id);
    const after = await doc(c, up.document.id);
    assert.equal(after.publishedVersionId, v2);
    assert.equal(after.indexedVersionId, null);
    assert.equal((await ver(c, up.version.id)).status, 'superseded');
    assert.equal((await docChunks()).length, 0);
    const search = await app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent('quarterly zebra forecast')}`, headers: c.viewer.headers });
    if (search.statusCode === 200) assert.ok(!search.body.includes(up.document.id), search.body);
  });

  test('an older version still indexing cannot overtake a newer published no-text version', async () => {
    const c = await setup();
    const up = await upload(c, 'report.pdf', PDF_TEXT);
    await settle(c.tenant.id);
    const v2 = await replace(c, up.document.id, 'report.pdf', `${PDF_TEXT}More.\n`);
    // v2 has been read and waits for its embedding job when v3 arrives.
    await withTenantTx(c.tenant.id, (tx) => tx.update(versions).set({ status: 'indexing' }).where(eq(versions.id, v2)));
    const v3 = await replace(c, up.document.id, 'report.png', PNG_NO_TEXT);
    await settle(c.tenant.id);
    assert.equal((await doc(c, up.document.id)).publishedVersionId, v3);
    assert.equal((await ver(c, v2)).status, 'superseded');
  });

  test('withdraw and archive clear the published version', async () => {
    const c = await setup();
    const a = await upload(c, 'a.png', PNG_NO_TEXT);
    const b = await upload(c, 'b.png', Buffer.concat([PNG_NO_TEXT, Buffer.from('b')]));
    await settle(c.tenant.id);
    assert.equal((await doc(c, a.document.id)).publishedVersionId, a.version.id);
    const w = await app.inject({ method: 'POST', url: `/api/v1/files/${a.document.id}/withdraw`, headers: c.ownerHeaders });
    assert.equal(w.statusCode, 200, w.body);
    assert.equal((await doc(c, a.document.id)).publishedVersionId, null);
    const ar = await app.inject({ method: 'POST', url: `/api/v1/files/${b.document.id}/archive`, headers: c.ownerHeaders });
    assert.equal(ar.statusCode, 200, ar.body);
    assert.equal((await doc(c, b.document.id)).publishedVersionId, null);
    assert.equal((await get(c.viewer.headers, `/api/v1/versions/${a.version.id}/file`)).statusCode, 404);
  });

  test('migration backfill publishes the newest stored version after the indexed one', async () => {
    const c = await setup();
    const up = await upload(c, 'report.pdf', PDF_TEXT);
    await settle(c.tenant.id);
    const img = await upload(c, 'only.png', PNG_NO_TEXT);
    await settle(c.tenant.id);
    // The old rules: a stored v2 after an indexed v1, nothing published, no_text unset.
    const v2 = await replace(c, up.document.id, 'report.pdf', '%PDF-1.7\nFAKE-EXTRACT\nNew words.\n');
    await withTenantTx(c.tenant.id, async (tx) => {
      await tx.update(versions).set({ status: 'stored', noText: false }).where(eq(versions.id, v2));
      await tx.update(versions).set({ noText: false }).where(eq(versions.id, img.version.id));
      await tx.update(documents).set({ publishedVersionId: null }).where(eq(documents.tenantId, c.tenant.id));
    });
    const file = fileURLToPath(new URL('../../../packages/db/migrations/0052_published_versions.sql', import.meta.url));
    const statements = readFileSync(file, 'utf8').split('--> statement-breakpoint').filter((s) => /^\s*UPDATE/m.test(s));
    assert.equal(statements.length, 3);
    await withTenantTx(c.tenant.id, async (tx) => {
      for (const s of statements) await tx.execute(sql.raw(s.replace(/^--.*$/gm, '')));
    });
    assert.equal((await doc(c, up.document.id)).publishedVersionId, v2);
    assert.equal((await doc(c, img.document.id)).publishedVersionId, img.version.id);
    assert.equal((await ver(c, v2)).noText, true);
    const [indexedOnly] = await withTenantTx(c.tenant.id, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(versions).where(and(eq(versions.documentId, up.document.id), eq(versions.noText, true)))
    );
    assert.equal(indexedOnly!.n, 1);
  });
});
