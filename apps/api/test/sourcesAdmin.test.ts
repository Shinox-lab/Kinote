import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { auditEvents, sourceItems, sources, documents, withTenantTx } from '@kinote/db';
import { ERROR_SENTENCES } from '@kinote/contracts';
import { buildTestApp, bootstrapTenant, signUpMember, useTestDb } from './support/testkit.js';

describe('sources admin routes', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
  });

  async function setup() {
    const { tenant, owner, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Src Co', slug: 'src-co' });
    const admin = await signUpMember(app, tenant.id, 'admin');
    const member = await signUpMember(app, tenant.id, 'member');
    const mk = async (name: string) =>
      (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name, slug: name.toLowerCase(), review_required: false } })).json();
    const docs = await mk('Docs');
    const other = await mk('Other');
    const second = await bootstrapTenant(app, { name: 'Other Co', slug: 'other-co' });
    const foreignSpace = (
      await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: second.headers, payload: { name: 'Foreign', slug: 'foreign', review_required: false } })
    ).json();
    return { tenant, owner, ownerHeaders, inboxSpace, admin, member, docs, other, second, foreignSpace };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const create = (headers: Record<string, string>, body: unknown) =>
    app.inject({ method: 'POST', url: '/api/v1/sources', headers, payload: body as object });
  const list = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/v1/sources', headers });
  const patch = (headers: Record<string, string>, id: string, body: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/sources/${id}`, headers, payload: body as object });
  const issue = (headers: Record<string, string>, id: string, body: unknown = { name: 'ci' }) =>
    app.inject({ method: 'POST', url: `/api/v1/sources/${id}/tokens`, headers, payload: body as object });
  const revoke = (headers: Record<string, string>, id: string, tokenId: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/sources/${id}/tokens/${tokenId}`, headers });
  const mkSource = async (c: Ctx, name = 'Reports') => {
    const res = await create(c.ownerHeaders, { name, target_space_id: c.docs.id });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string };
  };
  const events = (tenantId: string, type: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.type, type as never))));

  test('owners and admins create and list sources; a new source is untrusted, active and empty', async () => {
    const c = await setup();
    const a = await create(c.ownerHeaders, { name: 'Reports', target_space_id: c.docs.id });
    assert.equal(a.statusCode, 201, a.body);
    assert.deepEqual(
      { ...(a.json() as object), id: undefined, createdAt: undefined },
      { id: undefined, kind: 'upload_api', name: 'Reports', targetSpaceId: c.docs.id, targetSpaceName: 'Docs', trusted: false, status: 'active', itemCount: 0, lastSyncAt: null, createdAt: undefined, tokens: [] }
    );
    assert.equal((await create(c.admin.headers, { name: 'Second', target_space_id: c.other.id })).statusCode, 201);
    const listed = await list(c.admin.headers);
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().map((s: { name: string }) => s.name).sort(), ['Reports', 'Second']);
    assert.equal((await events(c.tenant.id, 'source.created')).length, 2);
  });

  test('a member cannot use any of the five routes (403)', async () => {
    const c = await setup();
    const s = await mkSource(c);
    const t = (await issue(c.ownerHeaders, s.id)).json();
    for (const res of [
      await create(c.member.headers, { name: 'X', target_space_id: c.docs.id }),
      await list(c.member.headers),
      await patch(c.member.headers, s.id, { trusted: true }),
      await issue(c.member.headers, s.id),
      await revoke(c.member.headers, s.id, t.info.id),
    ]) {
      assert.equal(res.statusCode, 403, res.body);
    }
  });

  test('the target space must be live, in this tenant, and not the Inbox', async () => {
    const c = await setup();
    const unknown = await create(c.ownerHeaders, { name: 'A', target_space_id: '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b' });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error, 'space_not_found');
    const foreign = await create(c.ownerHeaders, { name: 'B', target_space_id: c.foreignSpace.id });
    assert.equal(foreign.statusCode, 404);
    assert.equal(foreign.json().error, 'space_not_found');
    const inbox = await create(c.ownerHeaders, { name: 'C', target_space_id: c.inboxSpace.id });
    assert.equal(inbox.statusCode, 400);
    assert.equal(inbox.json().error, 'validation_failed');
    await app.inject({ method: 'POST', url: `/api/v1/spaces/${c.other.id}/archive`, headers: c.ownerHeaders });
    const archived = await create(c.ownerHeaders, { name: 'D', target_space_id: c.other.id });
    assert.equal(archived.statusCode, 409);
    assert.equal(archived.json().error, 'space_archived');
    const s = await mkSource(c, 'E');
    assert.equal((await patch(c.ownerHeaders, s.id, { target_space_id: c.other.id })).json().error, 'space_archived');
    assert.equal((await patch(c.ownerHeaders, s.id, { target_space_id: c.inboxSpace.id })).statusCode, 400);
  });

  test('a name that differs only by case is taken (409), and the sentence is the plain one', async () => {
    const c = await setup();
    await mkSource(c, 'Reports');
    const dup = await create(c.ownerHeaders, { name: 'REPORTS', target_space_id: c.docs.id });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error, 'source_name_taken');
    assert.equal(dup.json().message, ERROR_SENTENCES.source_name_taken);
    // The other tenant may use the same name.
    const other = await create(c.second.headers, { name: 'Reports', target_space_id: c.foreignSpace.id });
    assert.equal(other.statusCode, 201, other.body);
  });

  test('PATCH changes name, target, trusted and status and audits before and after', async () => {
    const c = await setup();
    const s = await mkSource(c);
    const res = await patch(c.admin.headers, s.id, { name: 'Renamed', target_space_id: c.other.id, trusted: true, status: 'paused' });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      { name: res.json().name, target: res.json().targetSpaceName, trusted: res.json().trusted, status: res.json().status },
      { name: 'Renamed', target: 'Other', trusted: true, status: 'paused' }
    );
    const [event] = await events(c.tenant.id, 'source.updated');
    assert.equal(event!.actorType, 'user');
    assert.equal(event!.actorId, c.admin.userId);
    assert.deepEqual((event!.payload as { before: unknown }).before, { name: 'Reports', targetSpaceId: c.docs.id, trusted: false, status: 'active' });
    assert.deepEqual((event!.payload as { after: unknown }).after, { name: 'Renamed', targetSpaceId: c.other.id, trusted: true, status: 'paused' });
    assert.equal((await patch(c.ownerHeaders, s.id, {})).statusCode, 400);
  });

  test("another tenant's source is 404 source_not_found on every route", async () => {
    const c = await setup();
    const s = await mkSource(c);
    const t = (await issue(c.ownerHeaders, s.id)).json();
    for (const res of [
      await patch(c.second.headers, s.id, { trusted: true }),
      await issue(c.second.headers, s.id),
      await revoke(c.second.headers, s.id, t.info.id),
      await patch(c.ownerHeaders, '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b', { trusted: true }),
      await patch(c.ownerHeaders, 'not-a-uuid', { trusted: true }),
    ]) {
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error, 'source_not_found');
    }
    assert.deepEqual((await list(c.second.headers)).json(), []);
  });

  test('issuing a token shows the secret once; listing and audit never carry it', async () => {
    const c = await setup();
    const s = await mkSource(c);
    const res = await issue(c.ownerHeaders, s.id, { name: 'nightly script' });
    assert.equal(res.statusCode, 201, res.body);
    const { token, info } = res.json() as { token: string; info: { id: string; name: string; prefix: string; expiresAt: null } };
    assert.match(token, /^lwsrc_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(info.name, 'nightly script');
    assert.equal(info.expiresAt, null);
    assert.ok(token.split('.')[1]!.startsWith(info.prefix));

    const listed = await list(c.ownerHeaders);
    const text = listed.body;
    assert.ok(!text.includes(token), 'list carries the secret');
    assert.ok(!text.includes(token.split('.')[1]!), 'list carries the secret part');
    assert.ok(!/token_?hash/i.test(text), 'list carries a hash');
    assert.equal(listed.json()[0].tokens[0].prefix, info.prefix);

    const [event] = await events(c.tenant.id, 'source.token_issued');
    assert.deepEqual(event!.payload, { sourceId: s.id, tokenId: info.id, name: 'nightly script' });
    assert.ok(!JSON.stringify(event).includes(token.split('.')[1]!));
  });

  test('expires_in_days sets an expiry that many days ahead', async () => {
    const c = await setup();
    const s = await mkSource(c);
    const res = await issue(c.ownerHeaders, s.id, { name: 'short', expires_in_days: 2 });
    const expires = Date.parse(res.json().info.expiresAt);
    const days = (expires - Date.now()) / 86_400_000;
    assert.ok(days > 1.99 && days <= 2, String(days));
    assert.equal((await issue(c.ownerHeaders, s.id, { name: 'bad', expires_in_days: 0 })).statusCode, 400);
  });

  test('revoking sets revokedAt, repeating it changes nothing, and a token of another source is 404', async () => {
    const c = await setup();
    const s = await mkSource(c);
    const s2 = await mkSource(c, 'Other source');
    const t = (await issue(c.ownerHeaders, s.id)).json() as { info: { id: string } };
    const first = await revoke(c.ownerHeaders, s.id, t.info.id);
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(first.json().revokedAt);
    const again = await revoke(c.ownerHeaders, s.id, t.info.id);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().revokedAt, first.json().revokedAt);
    assert.equal((await events(c.tenant.id, 'source.token_revoked')).length, 1);
    const wrong = await revoke(c.ownerHeaders, s2.id, t.info.id);
    assert.equal(wrong.statusCode, 404);
    assert.equal(wrong.json().error, 'source_not_found');
  });

  test('itemCount counts only items that are not removed', async () => {
    const c = await setup();
    const s = await mkSource(c);
    await withTenantTx(c.tenant.id, async (tx) => {
      for (const [i, deleted] of [[1, false], [2, false], [3, true]] as const) {
        const id = `6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5${i}`;
        await tx.insert(documents).values({ id, tenantId: c.tenant.id, spaceId: c.docs.id, kind: 'file', title: `f${i}`, createdByType: 'connector', createdBy: s.id, sourceId: s.id });
        await tx.insert(sourceItems).values({ tenantId: c.tenant.id, sourceId: s.id, externalId: `e${i}`, documentId: id, contentHash: 'h', deletedAt: deleted ? new Date() : null });
      }
    });
    assert.equal((await list(c.ownerHeaders)).json()[0].itemCount, 2);
    const [row] = await withTenantTx(c.tenant.id, (tx) => tx.select({ id: sources.id }).from(sources).where(eq(sources.id, s.id)));
    assert.ok(row);
  });
});
