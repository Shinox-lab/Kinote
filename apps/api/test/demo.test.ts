import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { auditEvents, getDb, memberships, pages, sessions, spaceGrants, spaces, tenants, users, withTenantTx } from '@kinote/db';
import { asUser, bootstrapTenant, buildTestApp, signUp, useTestDb } from './support/testkit.js';

describe('leaving a workspace, and the demo content', () => {
  const app = buildTestApp();
  useTestDb();

  async function demoWorld(plan: string) {
    const base = await bootstrapTenant(app, { name: 'Northwind Studio', slug: 'northwind' });
    await withTenantTx(base.tenant.id, (tx) => tx.update(tenants).set({ plan }).where(eq(tenants.id, base.tenant.id)));
    for (const [slug, review] of [['engineering', false], ['clients', true]] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: base.headers, payload: { name: slug, slug, review_required: review } });
      assert.equal(res.statusCode, 201, res.body);
    }
    return base;
  }

  async function grantsOf(tenantId: string, userId: string) {
    return withTenantTx(tenantId, async (tx) => {
      const rows = await tx
        .select({ slug: spaces.slug, role: spaceGrants.role })
        .from(spaceGrants)
        .innerJoin(spaces, eq(spaces.id, spaceGrants.spaceId))
        .where(and(eq(spaceGrants.tenantId, tenantId), eq(spaceGrants.principalId, userId)));
      return Object.fromEntries(rows.map((r) => [r.slug, r.role]));
    });
  }

  const roleOf = (tenantId: string, userId: string) =>
    withTenantTx(tenantId, async (tx) => {
      const [m] = await tx.select().from(memberships).where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
      return m?.role;
    });

  test('leaving removes the membership and the grants, and they are no longer a member', async () => {
    const w = await demoWorld('standard');
    const visitor = await signUp(app);
    await withTenantTx(w.tenant.id, (tx) => tx.insert(memberships).values({ tenantId: w.tenant.id, userId: visitor.userId, role: 'member' }));
    const engineering = await withTenantTx(w.tenant.id, (tx) => tx.select().from(spaces).where(eq(spaces.slug, 'engineering')));
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(spaceGrants).values({ tenantId: w.tenant.id, spaceId: engineering[0].id, principalType: 'user', principalId: visitor.userId, role: 'editor' })
    );
    assert.deepEqual(await grantsOf(w.tenant.id, visitor.userId), { engineering: 'editor' });

    const left = await app.inject({ method: 'DELETE', url: '/api/v1/members/me', headers: asUser(visitor, w.tenant.id) });
    assert.equal(left.statusCode, 204, left.body);
    assert.equal(await roleOf(w.tenant.id, visitor.userId), undefined);
    assert.deepEqual(await grantsOf(w.tenant.id, visitor.userId), {});

    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(visitor) })).json();
    assert.deepEqual(me.memberships, []);
    const again = await app.inject({ method: 'DELETE', url: '/api/v1/members/me', headers: asUser(visitor, w.tenant.id) });
    assert.equal(again.statusCode, 404, again.body);
  });

  test('the last owner cannot leave', async () => {
    const w = await demoWorld('standard');
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/members/me', headers: w.headers });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'last_owner');
  });

  describe('demo content for an empty workspace', () => {
    test('an admin of an empty workspace can seed; a member cannot ask', async () => {
      const w = await bootstrapTenant(app, { name: 'Blank', slug: 'blank' });
      const status = await app.inject({ method: 'GET', url: '/api/v1/demo-seed', headers: w.headers });
      assert.equal(status.statusCode, 200, status.body);
      assert.deepEqual(status.json(), { state: 'idle', canSeed: true, canReset: false });

      const member = await signUp(app);
      await withTenantTx(w.tenant.id, (tx) => tx.insert(memberships).values({ tenantId: w.tenant.id, userId: member.userId, role: 'member' }));
      const denied = await app.inject({ method: 'GET', url: '/api/v1/demo-seed', headers: asUser(member, w.tenant.id) });
      assert.equal(denied.statusCode, 403, denied.body);
    });

    test('a workspace with a space of its own is refused', async () => {
      const w = await bootstrapTenant(app, { name: 'Used', slug: 'used' });
      const made = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: w.headers, payload: { name: 'Docs', slug: 'docs' } });
      assert.equal(made.statusCode, 201, made.body);

      const status = await app.inject({ method: 'GET', url: '/api/v1/demo-seed', headers: w.headers });
      assert.equal(status.json().canSeed, false);
      const start = await app.inject({ method: 'POST', url: '/api/v1/demo-seed', headers: w.headers });
      assert.equal(start.statusCode, 409, start.body);
      assert.equal(start.json().error, 'workspace_not_empty');
    });

    test('only a workspace the demo went into can be reset', async () => {
      const w = await bootstrapTenant(app, { name: 'Real', slug: 'real' });
      const res = await app.inject({ method: 'POST', url: '/api/v1/demo-seed/reset', headers: w.headers });
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(res.json().error, 'not_demo_workspace');
      await assert.rejects(withTenantTx(w.tenant.id, (tx) => tx.execute(sql`SELECT reset_demo_workspace(${w.tenant.id}::uuid)`)));
    });

    test('a reset empties the workspace but keeps its members and Inbox, and removes the demo colleagues', async () => {
      const w = await demoWorld('demo');
      const other = await bootstrapTenant(app, { name: 'Elsewhere', slug: 'elsewhere' });
      const docs = (await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: w.headers, payload: { name: 'Docs', slug: 'docs' } })).json();
      const page = await app.inject({ method: 'POST', url: '/api/v1/pages', headers: w.headers, payload: { space_id: docs.id, title: 'Plan', slug: 'plan', markdown: 'Text.' } });
      assert.equal(page.statusCode, 201, page.body);
      const visitor = await signUp(app);
      const [mei] = await getDb().insert(users).values({ email: 'mei-x1@demo.example', name: 'Mei', passwordHash: '!' }).returning();
      await withTenantTx(w.tenant.id, (tx) =>
        tx.insert(memberships).values([
          { tenantId: w.tenant.id, userId: visitor.userId, role: 'member' },
          { tenantId: w.tenant.id, userId: mei.id, role: 'member' },
        ])
      );

      // Not from another workspace's context.
      await assert.rejects(withTenantTx(other.tenant.id, (tx) => tx.execute(sql`SELECT reset_demo_workspace(${w.tenant.id}::uuid)`)));
      await withTenantTx(w.tenant.id, (tx) => tx.execute(sql`SELECT reset_demo_workspace(${w.tenant.id}::uuid)`));

      const left = await withTenantTx(w.tenant.id, async (tx) => ({
        spaces: (await tx.select().from(spaces)).map((s) => s.kind),
        pages: (await tx.select().from(pages)).length,
        audit: (await tx.select().from(auditEvents)).length,
        members: (await tx.select().from(memberships)).map((m) => m.userId).sort(),
        plan: (await tx.select().from(tenants))[0].plan,
      }));
      assert.deepEqual(left, { spaces: ['inbox'], pages: 0, audit: 0, members: [w.owner.userId, visitor.userId].sort(), plan: 'demo' });
      assert.equal((await getDb().select().from(users).where(eq(users.id, mei.id))).length, 0);
      assert.equal((await getDb().select().from(sessions).where(eq(sessions.userId, mei.id))).length, 0);
      const elsewhere = await withTenantTx(other.tenant.id, (tx) => tx.select().from(spaces));
      assert.equal(elsewhere.length, 1);

      const status = (await app.inject({ method: 'GET', url: '/api/v1/demo-seed', headers: w.headers })).json();
      assert.deepEqual(status, { state: 'idle', canSeed: true, canReset: true });
    });
  });

  describe('deleting a workspace', () => {
    test('only an owner can', async () => {
      const w = await bootstrapTenant(app, { name: 'Keep', slug: 'keep' });
      const admin = await signUp(app);
      await withTenantTx(w.tenant.id, (tx) => tx.insert(memberships).values({ tenantId: w.tenant.id, userId: admin.userId, role: 'admin' }));
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/tenant', headers: asUser(admin, w.tenant.id) });
      assert.equal(res.statusCode, 403, res.body);
    });

    test('an ordinary workspace is hidden from everyone, keeps its data, and frees its slug', async () => {
      const w = await demoWorld('standard');
      const member = await signUp(app);
      await withTenantTx(w.tenant.id, (tx) => tx.insert(memberships).values({ tenantId: w.tenant.id, userId: member.userId, role: 'member' }));

      const res = await app.inject({ method: 'DELETE', url: '/api/v1/tenant', headers: w.headers });
      assert.equal(res.statusCode, 204, res.body);

      for (const who of [w.owner, member]) {
        const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(who) })).json();
        assert.deepEqual(me.memberships, []);
        const spacesRes = await app.inject({ method: 'GET', url: '/api/v1/spaces', headers: asUser(who, w.tenant.id) });
        assert.equal(spacesRes.statusCode, 404, spacesRes.body);
      }
      const kept = await withTenantTx(w.tenant.id, async (tx) => ({
        tenant: (await tx.select().from(tenants))[0],
        spaces: (await tx.select().from(spaces)).length,
        audit: (await tx.select().from(auditEvents)).map((e) => e.type),
      }));
      assert.ok(kept.tenant.deletedAt);
      assert.equal(kept.tenant.slug, `deleted-${w.tenant.id}`);
      assert.equal(kept.spaces, 3);
      assert.ok(kept.audit.includes('tenant.deleted'));

      const again = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants',
        headers: asUser(w.owner),
        payload: { name: 'Northwind Studio', slug: 'northwind' },
      });
      assert.equal(again.statusCode, 201, again.body);
    });

    test('a demo workspace is purged: every row of it and its demo colleagues', async () => {
      const w = await demoWorld('demo');
      const other = await bootstrapTenant(app, { name: 'Elsewhere', slug: 'elsewhere' });
      const [mei] = await getDb().insert(users).values({ email: 'mei-x2@demo.example', name: 'Mei', passwordHash: '!' }).returning();
      await withTenantTx(w.tenant.id, (tx) => tx.insert(memberships).values({ tenantId: w.tenant.id, userId: mei.id, role: 'member' }));

      const res = await app.inject({ method: 'DELETE', url: '/api/v1/tenant', headers: w.headers });
      assert.equal(res.statusCode, 204, res.body);

      const left = await withTenantTx(w.tenant.id, async (tx) => ({
        tenants: (await tx.select().from(tenants)).length,
        spaces: (await tx.select().from(spaces)).length,
        members: (await tx.select().from(memberships)).length,
        audit: (await tx.select().from(auditEvents)).length,
      }));
      assert.deepEqual(left, { tenants: 0, spaces: 0, members: 0, audit: 0 });
      assert.equal((await getDb().select().from(users).where(eq(users.id, mei.id))).length, 0);
      assert.equal((await getDb().select().from(users).where(eq(users.id, w.owner.userId))).length, 1);
      assert.equal((await withTenantTx(other.tenant.id, (tx) => tx.select().from(spaces))).length, 1);
      const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(w.owner) })).json();
      assert.deepEqual(me.memberships, []);
    });
  });
});
