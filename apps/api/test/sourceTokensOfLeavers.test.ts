import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, withTenantTx } from '@kinote/db';
import { SourceListSchema } from '@kinote/contracts';
import { InMemoryObjectStorage } from '@kinote/shared';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';
import { multipartBody } from './support/multipart.js';

describe('source tokens of people who left', () => {
  useTestDb();

  async function setup() {
    const app = buildTestApp({ storage: new InMemoryObjectStorage() });
    const { tenant, owner, headers: ownerHeaders } = await bootstrapTenant(app, { name: 'Leavers Co', slug: 'leavers-co' });
    const leaver = await signUpMember(app, tenant.id, 'admin', 'leaver@example.test');
    const member = await signUpMember(app, tenant.id, 'member');
    const space = (
      await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders, payload: { name: 'Docs', slug: 'docs', review_required: false } })
    ).json();
    const source = async (headers: Record<string, string>, name: string) =>
      (await app.inject({ method: 'POST', url: '/api/v1/sources', headers, payload: { name, target_space_id: space.id } })).json() as { id: string };
    const issue = async (headers: Record<string, string>, sourceId: string, name: string) =>
      (await app.inject({ method: 'POST', url: `/api/v1/sources/${sourceId}/tokens`, headers, payload: { name } })).json() as {
        token: string;
        info: { id: string };
      };
    const list = async () => SourceListSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/sources', headers: ownerHeaders })).json());
    const put = (token: string) => {
      const { payload, contentType } = multipartBody([{ name: 'file', filename: 'a.txt', data: 'hello' }]);
      return app.inject({
        method: 'PUT',
        url: `/api/v1/source/files/a-${Math.random()}`,
        headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
        payload,
      });
    };
    const revokeBy = (headers: Record<string, string>, createdBy: string) =>
      app.inject({ method: 'POST', url: '/api/v1/source-tokens/revoke', headers, payload: { created_by: createdBy } });
    return { app, tenant, owner, ownerHeaders, leaver, member, source, issue, list, put, revokeBy };
  }

  test('each token names its maker and their role now; after removal the role is null and the tokens still work', async () => {
    const c = await setup();
    const reports = await c.source(c.leaver.headers, 'Reports');
    const issued = await c.issue(c.leaver.headers, reports.id, 'nightly');
    const [before] = await c.list();
    expect(before!.tokens[0]!.createdBy).toEqual({ id: c.leaver.userId, name: 'leaver', role: 'admin' });

    expect((await c.app.inject({ method: 'DELETE', url: `/api/v1/members/${c.leaver.userId}`, headers: c.ownerHeaders })).statusCode).toBe(204);
    const [after] = await c.list();
    expect(after!.tokens[0]!.createdBy).toEqual({ id: c.leaver.userId, name: 'leaver', role: null });
    // Removing the person does not stop their token: that is what the admin pages point out.
    expect((await c.put(issued.token)).statusCode).toBe(201);
  });

  test('one call revokes every unrevoked token the person made, across sources, and audits each', async () => {
    const c = await setup();
    const reports = await c.source(c.leaver.headers, 'Reports');
    const exports = await c.source(c.ownerHeaders, 'Exports');
    const a = await c.issue(c.leaver.headers, reports.id, 'a');
    const b = await c.issue(c.leaver.headers, exports.id, 'b');
    const already = await c.issue(c.leaver.headers, exports.id, 'already');
    await c.app.inject({ method: 'DELETE', url: `/api/v1/sources/${exports.id}/tokens/${already.info.id}`, headers: c.ownerHeaders });
    const owners = await c.issue(c.ownerHeaders, reports.id, 'owners');
    await c.app.inject({ method: 'DELETE', url: `/api/v1/members/${c.leaver.userId}`, headers: c.ownerHeaders });

    const res = await c.revokeBy(c.ownerHeaders, c.leaver.userId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });
    for (const t of [a, b]) expect((await c.put(t.token)).statusCode).toBe(401);
    expect((await c.put(owners.token)).statusCode).toBe(201);

    const events = await withTenantTx(c.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, c.tenant.id), eq(auditEvents.type, 'source.token_revoked')))
    );
    expect(events.map((e) => (e.payload as { tokenId: string }).tokenId).sort()).toEqual([a.info.id, already.info.id, b.info.id].sort());

    // Again: nothing left to revoke.
    expect((await c.revokeBy(c.ownerHeaders, c.leaver.userId)).json()).toEqual({ revoked: 0 });
  });

  test('only owners and admins may, and only in their own workspace', async () => {
    const c = await setup();
    const reports = await c.source(c.leaver.headers, 'Reports');
    const issued = await c.issue(c.leaver.headers, reports.id, 'nightly');

    expect((await c.revokeBy(c.member.headers, c.leaver.userId)).statusCode).toBe(403);
    const other = await bootstrapTenant(c.app, { name: 'Other Co', slug: 'other-co' });
    expect((await c.revokeBy(other.headers, c.leaver.userId)).json()).toEqual({ revoked: 0 });
    expect((await c.revokeBy(c.ownerHeaders, 'not-a-uuid')).statusCode).toBe(400);
    expect((await c.put(issued.token)).statusCode).toBe(201);
  });
});
