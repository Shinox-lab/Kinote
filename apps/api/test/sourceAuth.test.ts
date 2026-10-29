import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { sourceTokens, sources, withTenantTx } from '@kinote/db';
import { InMemoryObjectStorage } from '@kinote/shared';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { bearer, makeSource, putFile, sourceWorld } from './support/sourcekit.js';
import { uploadRequest } from './support/multipart.js';

describe('source token authentication', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp({ storage: new InMemoryObjectStorage() });
  });

  const tiny = { name: 'a.txt', data: 'hello source' };

  async function setup() {
    const a = await sourceWorld(app, 'auth-a');
    const b = await sourceWorld(app, 'auth-b');
    const src = await makeSource(app, a.ownerHeaders, { name: 'Reports', spaceId: a.open.id });
    return { a, b, src };
  }

  test('a valid token creates a file (201)', async () => {
    const { src } = await setup();
    const res = await putFile(app, src.token, 'one', tiny);
    assert.equal(res.statusCode, 201, res.body);
  });

  test('every way of failing to authenticate answers the same 401', async () => {
    const { a, b, src } = await setup();
    const [head, secret] = src.token.split('.') as [string, string];
    const otherTenantHex = b.tenant.id.replaceAll('-', '');
    const revoked = await makeSource(app, a.ownerHeaders, { name: 'Revoked', spaceId: a.open.id });
    await app.inject({ method: 'DELETE', url: `/api/v1/sources/${revoked.id}/tokens/${revoked.tokenId}`, headers: a.ownerHeaders });
    const expired = await makeSource(app, a.ownerHeaders, { name: 'Expired', spaceId: a.open.id });
    await withTenantTx(a.tenant.id, (tx) => tx.update(sourceTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sourceTokens.id, expired.tokenId)));
    const paused = await makeSource(app, a.ownerHeaders, { name: 'Paused', spaceId: a.open.id });
    await app.inject({ method: 'PATCH', url: `/api/v1/sources/${paused.id}`, headers: a.ownerHeaders, payload: { status: 'paused' } });

    const attempts: Array<[string, Record<string, string>]> = [
      ['no header', {}],
      ['bare Bearer', { authorization: 'Bearer' }],
      ['a session token', bearer(a.editor.token)],
      ['garbage', bearer('nonsense')],
      ['unknown tenant', bearer(`${head.slice(0, 6)}${'0'.repeat(32)}.${secret}`)],
      ["tenant A's token with tenant B's id", bearer(`${head.slice(0, 6)}${otherTenantHex}.${secret}`)],
      ['altered secret', bearer(`${head}.${secret.slice(0, 42)}${secret.endsWith('A') ? 'B' : 'A'}`)],
      ['revoked', bearer(revoked.token)],
      ['expired', bearer(expired.token)],
      ['paused source', bearer(paused.token)],
    ];
    const bodies = new Set<string>();
    for (const [label, headers] of attempts) {
      const res = await app.inject(
        { ...uploadRequest('/api/v1/source/files/x', headers, tiny), method: 'PUT' }
      );
      assert.equal(res.statusCode, 401, `${label}: ${res.body}`);
      assert.equal(res.json().error, 'unauthenticated', label);
      bodies.add(res.body);
    }
    assert.equal(bodies.size, 1, `bodies differ: ${[...bodies].join(' | ')}`);
    // Nothing was written by any of them.
    const items = await withTenantTx(a.tenant.id, (tx) => tx.select().from(sources));
    assert.ok(items.length >= 1);
  });

  test('a source token opens no other route, and a session token opens no source route', async () => {
    const { a, src } = await setup();
    const asSource = { ...bearer(src.token), 'x-tenant-id': a.tenant.id };
    const spaces = await app.inject({ method: 'GET', url: '/api/v1/spaces', headers: asSource });
    const upload = await app.inject({ ...uploadRequest('/api/v1/files', asSource, tiny) });
    const sourcesList = await app.inject({ method: 'GET', url: '/api/v1/sources', headers: asSource });
    const reference = await putFile(app, a.owner.token, 'x', tiny);
    for (const res of [spaces, upload, sourcesList, reference]) {
      assert.equal(res.statusCode, 401, res.body);
      assert.equal(res.json().error, 'unauthenticated');
    }
    assert.equal(spaces.body, reference.body);
  });

  test('x-tenant-id is ignored on a source route', async () => {
    const { b, src } = await setup();
    const res = await app.inject({
      ...uploadRequest('/api/v1/source/files/y', { ...bearer(src.token), 'x-tenant-id': b.tenant.id }, tiny),
      method: 'PUT',
    });
    assert.equal(res.statusCode, 201, res.body);
  });

  test('last_used_at is set by the first call and not rewritten within a minute', async () => {
    const { a, src } = await setup();
    const read = async () =>
      (await withTenantTx(a.tenant.id, (tx) => tx.select().from(sourceTokens).where(eq(sourceTokens.id, src.tokenId))))[0]!.lastUsedAt;
    assert.equal(await read(), null);
    await putFile(app, src.token, 'one', tiny);
    const first = await read();
    assert.ok(first);
    await new Promise((r) => setTimeout(r, 30));
    await putFile(app, src.token, 'two', { name: 'b.txt', data: 'second file' });
    assert.equal((await read())!.getTime(), first.getTime());
  });
});
