import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { documents, sourceItems, versions, withTenantTx } from '@living-wiki/db';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor } from '@living-wiki/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { bearer, deleteFile, makeSource, pdf, putFile, sourceWorld, type SourceWorld } from './support/sourcekit.js';

/** Records every key stored, so tenant prefixes can be checked. */
class RecordingStorage extends InMemoryObjectStorage {
  keys: Array<{ tenantId: string; objectKey: string }> = [];
  async put(tenantId: string, path: string, bytes: Uint8Array, mime: string) {
    const out = await super.put(tenantId, path, bytes, mime);
    this.keys.push({ tenantId, objectKey: out.objectKey });
    return out;
  }
}

describe('sources across two tenants', () => {
  let storage: RecordingStorage;
  let app: ReturnType<typeof buildTestApp>;
  const extractor = new FakeExtractor();
  useTestDb();
  beforeEach(() => {
    storage = new RecordingStorage();
    app = buildTestApp({ storage });
  });

  /** Both tenants have a source and a published file under the same external id. */
  async function setup() {
    const a = await sourceWorld(app, 'iso-a');
    const b = await sourceWorld(app, 'iso-b');
    const srcA = await makeSource(app, a.ownerHeaders, { name: 'Feed', spaceId: a.open.id });
    const srcB = await makeSource(app, b.ownerHeaders, { name: 'Feed', spaceId: b.open.id });
    const publish = async (w: SourceWorld, token: string, text: string) => {
      const res = await putFile(app, token, 'shared-id', { name: 'doc.pdf', data: pdf(text) });
      assert.equal(res.statusCode, 201, res.body);
      await runPendingJobsForTenant(w.tenant.id, { storage, extractor });
      const [waiting] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(versions).where(eq(versions.documentId, res.json().document.id)));
      const ok = await app.inject({ method: 'POST', url: `/api/v1/versions/${waiting!.id}/approve`, headers: w.ownerHeaders, payload: {} });
      assert.equal(ok.statusCode, 200, ok.body);
      await runPendingJobsForTenant(w.tenant.id, { storage, extractor });
      return res.json() as { document: { id: string }; version: { id: string } };
    };
    const fileA = await publish(a, srcA.token, 'Alpha tenant narwhal ledger text.');
    const fileB = await publish(b, srcB.token, 'Beta tenant walrus ledger text.');
    return { a, b, srcA, srcB, fileA, fileB };
  }
  const get = (headers: Record<string, string>, url: string) => app.inject({ method: 'GET', url, headers });

  test("another tenant's admin cannot see, change, issue or revoke anything of a source", async () => {
    const { a, b, srcA } = await setup();
    const results = [
      await app.inject({ method: 'PATCH', url: `/api/v1/sources/${srcA.id}`, headers: b.ownerHeaders, payload: { trusted: true } }),
      await app.inject({ method: 'POST', url: `/api/v1/sources/${srcA.id}/tokens`, headers: b.ownerHeaders, payload: { name: 'x' } }),
      await app.inject({ method: 'DELETE', url: `/api/v1/sources/${srcA.id}/tokens/${srcA.tokenId}`, headers: b.ownerHeaders }),
    ];
    for (const res of results) {
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error, 'source_not_found');
    }
    const listed = (await get(b.ownerHeaders, '/api/v1/sources')).json() as Array<{ id: string }>;
    assert.ok(!listed.some((s) => s.id === srcA.id));
    const mine = (await get(a.ownerHeaders, '/api/v1/sources')).json() as Array<{ id: string; trusted: boolean; tokens: Array<{ revokedAt: string | null }> }>;
    assert.equal(mine[0]!.trusted, false);
    assert.equal(mine[0]!.tokens[0]!.revokedAt, null);
  });

  test("a token never works for another tenant, by path, by header or by rewriting its tenant part", async () => {
    const { a, b, srcA } = await setup();
    const [head, secret] = srcA.token.split('.') as [string, string];
    const forged = `${head.slice(0, 6)}${b.tenant.id.replaceAll('-', '')}.${secret}`;
    const attempts = [
      app.inject({ method: 'PUT', url: '/api/v1/source/files/shared-id', headers: { ...bearer(forged), 'x-tenant-id': b.tenant.id } }),
      app.inject({ method: 'DELETE', url: '/api/v1/source/files/shared-id', headers: { ...bearer(forged), 'x-tenant-id': b.tenant.id } }),
      app.inject({ method: 'DELETE', url: '/api/v1/source/files/shared-id', headers: { ...bearer(srcA.token), 'x-tenant-id': b.tenant.id } }),
    ];
    const [put, forgedDelete, headerDelete] = await Promise.all(attempts);
    assert.equal(put!.statusCode, 401);
    assert.equal(forgedDelete!.statusCode, 401);
    // The header is ignored, so this is A's own DELETE: it removes A's file and only A's.
    assert.equal(headerDelete!.statusCode, 200);
    const docs = await Promise.all([a, b].map((w) => withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.externalId, 'shared-id')))));
    assert.ok(docs[0]![0]!.sourceDeletedAt);
    assert.equal(docs[1]![0]!.sourceDeletedAt, null);
  });

  test('the same external id in two tenants is two files, and one tenant\'s DELETE leaves the other\'s alone', async () => {
    const { a, b, srcA, fileA, fileB } = await setup();
    assert.notEqual(fileA.document.id, fileB.document.id);
    assert.equal((await deleteFile(app, srcA.token, 'shared-id')).statusCode, 200);
    const search = async (w: SourceWorld, q: string) =>
      ((await app.inject({ method: 'POST', url: '/api/v1/search', headers: w.ownerHeaders, payload: { query: q } })).json().passages as Array<{ documentId: string }>);
    assert.equal((await search(a, 'narwhal ledger')).length, 0);
    assert.equal((await search(b, 'walrus ledger')).filter((p) => p.documentId === fileB.document.id).length, 1);
    const [item] = await withTenantTx(b.tenant.id, (tx) => tx.select().from(sourceItems));
    assert.equal(item!.deletedAt, null);
  });

  test("one tenant's files never show in the other's search, tree, queue, updates or file routes", async () => {
    const { a, b, fileA } = await setup();
    const hits = (await app.inject({ method: 'POST', url: '/api/v1/search', headers: b.ownerHeaders, payload: { query: 'narwhal ledger' } })).json().passages as Array<{ documentId: string; text: string }>;
    assert.ok(!hits.some((p) => p.documentId === fileA.document.id || /narwhal/.test(p.text)), 'found the other tenant\'s text');
    const tree = (await get(b.ownerHeaders, `/api/v1/spaces/${b.open.id}/tree`)).json().nodes as Array<{ id: string }>;
    assert.ok(!tree.some((n) => n.id === fileA.document.id));
    assert.ok(!JSON.stringify((await get(b.ownerHeaders, '/api/v1/updates')).json()).includes(fileA.document.id));
    assert.ok(!JSON.stringify((await get(b.ownerHeaders, '/api/v1/reviews')).json()).includes(fileA.document.id));
    const sameAsMissing = (await get(b.ownerHeaders, '/api/v1/files/5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b')).body;
    for (const url of [
      `/api/v1/files/${fileA.document.id}`,
      `/api/v1/files/${fileA.document.id}/versions`,
    ]) {
      const res = await get(b.ownerHeaders, url);
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.body, sameAsMissing, url);
    }
    for (const route of ['file', 'text', 'chunks']) {
      const res = await get(b.ownerHeaders, `/api/v1/versions/${fileA.version.id}/${route}`);
      assert.equal(res.statusCode, 404, route);
    }
    assert.equal((await get(a.ownerHeaders, `/api/v1/files/${fileA.document.id}`)).statusCode, 200);
  });

  test('every stored object lives under its own tenant', async () => {
    const { a, b } = await setup();
    assert.ok(storage.keys.length >= 4);
    for (const { tenantId, objectKey } of storage.keys) {
      assert.ok(objectKey.startsWith(`${tenantId}/`), objectKey);
      assert.ok([a.tenant.id, b.tenant.id].includes(tenantId));
    }
  });
});
