import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  auditEvents,
  groupMembers,
  memberships,
  spaceGrants,
} from '@kinote/db';
import {
  asUser,
  bootstrapTenant,
  buildTestApp,
  createAgent,
  signUp,
  signUpMember,
  useTestDb,
} from './support/testkit.js';

type Headers = Record<string, string>;

const RANDOM_UUID = '00000000-0000-4000-8000-000000000123';

describe('members, groups and grants administration', () => {
  const app = buildTestApp();
  useTestDb();

  async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: Headers, payload?: unknown) {
    return app.inject({ method, url, headers, payload: payload as any });
  }

  function expectError(res: { statusCode: number; json(): any; body: string }, status: number, code: string) {
    assert.equal(res.statusCode, status, res.body);
    assert.equal(res.json().error, code, res.body);
  }

  async function world() {
    const base = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const admin = await signUpMember(app, base.tenant.id, 'admin', 'admin@example.test');
    const member = await signUpMember(app, base.tenant.id, 'member', 'member@example.test');
    const viewer = await signUpMember(app, base.tenant.id, 'viewer', 'viewer@example.test');
    return { ...base, admin, member, viewer };
  }

  type World = Awaited<ReturnType<typeof world>>;

  async function createSpace(w: World, slug = 'docs') {
    const res = await call('POST', '/api/v1/spaces', w.headers, { name: slug, slug });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string };
  }

  async function grant(w: World, spaceId: string, type: string, id: string, role: string) {
    const res = await call('POST', `/api/v1/spaces/${spaceId}/grants`, w.headers, {
      principal_type: type,
      principal_id: id,
      role,
    });
    assert.equal(res.statusCode, 201, res.body);
  }

  async function createGroup(headers: Headers, name: string) {
    const res = await call('POST', '/api/v1/groups', headers, { name });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string; name: string; memberCount: number };
  }

  async function auditTypes(tenantId: string, type: string) {
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.type, type as any)))
    );
  }

  describe('members', () => {
    test('the list shows every member with email, name and role', async () => {
      const w = await world();
      const res = await call('GET', '/api/v1/members', w.headers);
      assert.equal(res.statusCode, 200, res.body);
      const byId = new Map<string, any>(res.json().map((m: any) => [m.userId, m]));
      assert.equal(byId.size, 4);
      assert.equal(byId.get(w.owner.userId).role, 'owner');
      assert.deepEqual(byId.get(w.admin.userId), {
        userId: w.admin.userId,
        email: 'admin@example.test',
        name: 'admin',
        role: 'admin',
      });
      assert.equal(byId.get(w.member.userId).role, 'member');
      assert.equal(byId.get(w.viewer.userId).role, 'viewer');
    });

    test('a role change is applied and audited with the old and new role', async () => {
      const w = await world();
      const res = await call('PATCH', `/api/v1/members/${w.member.userId}`, w.headers, { role: 'admin' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().role, 'admin');
      assert.equal(res.json().userId, w.member.userId);

      const events = await auditTypes(w.tenant.id, 'member.role_changed');
      assert.equal(events.length, 1);
      assert.equal(events[0].actorId, w.owner.userId);
      assert.equal(events[0].subjectId, w.member.userId);
      assert.deepEqual(events[0].payload, { oldRole: 'member', newRole: 'admin' });

      const list = (await call('GET', '/api/v1/members', w.headers)).json();
      assert.equal(list.find((m: any) => m.userId === w.member.userId).role, 'admin');
    });

    test('the only owner cannot demote themselves (409 last_owner) and cannot be removed', async () => {
      const w = await world();
      expectError(
        await call('PATCH', `/api/v1/members/${w.owner.userId}`, w.headers, { role: 'admin' }),
        409,
        'last_owner'
      );
      expectError(await call('DELETE', `/api/v1/members/${w.owner.userId}`, w.headers), 409, 'last_owner');

      const list = (await call('GET', '/api/v1/members', w.headers)).json();
      assert.equal(list.find((m: any) => m.userId === w.owner.userId).role, 'owner');
      assert.equal((await auditTypes(w.tenant.id, 'member.role_changed')).length, 0);
      assert.equal((await auditTypes(w.tenant.id, 'member.removed')).length, 0);
    });

    test('with two owners, one can be demoted and one can be removed', async () => {
      const w = await world();
      const second = await signUpMember(app, w.tenant.id, 'owner');
      const third = await signUpMember(app, w.tenant.id, 'owner');

      const demote = await call('PATCH', `/api/v1/members/${second.userId}`, w.headers, { role: 'member' });
      assert.equal(demote.statusCode, 200, demote.body);
      const remove = await call('DELETE', `/api/v1/members/${third.userId}`, w.headers);
      assert.equal(remove.statusCode, 204, remove.body);

      // One owner is left now: the same two moves on the remaining owner fail.
      expectError(
        await call('PATCH', `/api/v1/members/${w.owner.userId}`, w.headers, { role: 'viewer' }),
        409,
        'last_owner'
      );
    });

    test('an owner may promote someone to owner', async () => {
      const w = await world();
      const res = await call('PATCH', `/api/v1/members/${w.member.userId}`, w.headers, { role: 'owner' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().role, 'owner');
    });

    test('an admin cannot promote anyone to owner and cannot touch an owner', async () => {
      const w = await world();
      expectError(
        await call('PATCH', `/api/v1/members/${w.member.userId}`, w.admin.headers, { role: 'owner' }),
        403,
        'forbidden'
      );
      expectError(
        await call('PATCH', `/api/v1/members/${w.owner.userId}`, w.admin.headers, { role: 'admin' }),
        403,
        'forbidden'
      );
      expectError(await call('DELETE', `/api/v1/members/${w.owner.userId}`, w.admin.headers), 403, 'forbidden');

      // Even with a second owner an admin may not demote or remove an owner.
      const second = await signUpMember(app, w.tenant.id, 'owner');
      expectError(
        await call('PATCH', `/api/v1/members/${second.userId}`, w.admin.headers, { role: 'member' }),
        403,
        'forbidden'
      );
      expectError(await call('DELETE', `/api/v1/members/${second.userId}`, w.admin.headers), 403, 'forbidden');

      // An admin can manage non-owners.
      const ok = await call('PATCH', `/api/v1/members/${w.member.userId}`, w.admin.headers, { role: 'viewer' });
      assert.equal(ok.statusCode, 200, ok.body);
    });

    test('removing a member ends their session in the tenant and deletes their grants and group memberships', async () => {
      const w = await world();
      const space = await createSpace(w);
      const group = await createGroup(w.headers, 'Writers');
      await grant(w, space.id, 'user', w.member.userId, 'editor');
      await grant(w, space.id, 'user', w.viewer.userId, 'viewer');
      const add = await call('POST', `/api/v1/groups/${group.id}/members`, w.headers, {
        principal_type: 'user',
        principal_id: w.member.userId,
      });
      assert.equal(add.statusCode, 200, add.body);
      await call('POST', `/api/v1/groups/${group.id}/members`, w.headers, {
        principal_type: 'user',
        principal_id: w.viewer.userId,
      });
      assert.equal((await call('GET', `/api/v1/spaces/${space.id}`, w.member.headers)).statusCode, 200);

      const del = await call('DELETE', `/api/v1/members/${w.member.userId}`, w.headers);
      assert.equal(del.statusCode, 204, del.body);

      expectError(await call('GET', `/api/v1/spaces/${space.id}`, w.member.headers), 404, 'tenant_not_found');
      expectError(await call('GET', '/api/v1/spaces', w.member.headers), 404, 'tenant_not_found');

      const rows = await withTenantTx(w.tenant.id, async (tx) => ({
        memberships: await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.tenantId, w.tenant.id), eq(memberships.userId, w.member.userId))),
        grants: await tx.select().from(spaceGrants).where(eq(spaceGrants.tenantId, w.tenant.id)),
        groupMembers: await tx.select().from(groupMembers).where(eq(groupMembers.tenantId, w.tenant.id)),
      }));
      assert.equal(rows.memberships.length, 0);
      // Only the viewer's rows are left.
      assert.deepEqual(rows.grants.map((g) => g.principalId), [w.viewer.userId]);
      assert.deepEqual(rows.groupMembers.map((g) => g.principalId), [w.viewer.userId]);

      const events = await auditTypes(w.tenant.id, 'member.removed');
      assert.equal(events.length, 1);
      assert.equal(events[0].subjectId, w.member.userId);
      assert.equal(events[0].actorId, w.owner.userId);

      // Removing again: no longer a member.
      expectError(await call('DELETE', `/api/v1/members/${w.member.userId}`, w.headers), 404, 'principal_not_found');
    });

    test('unknown, malformed and other tenants user ids are 404 principal_not_found', async () => {
      const w = await world();
      const other = await bootstrapTenant(app, { name: 'Other', slug: 'other' });
      const otherMember = await signUpMember(app, other.tenant.id, 'member');
      for (const id of [RANDOM_UUID, 'not-a-uuid', otherMember.userId, other.owner.userId]) {
        expectError(await call('PATCH', `/api/v1/members/${id}`, w.headers, { role: 'viewer' }), 404, 'principal_not_found');
        expectError(await call('DELETE', `/api/v1/members/${id}`, w.headers), 404, 'principal_not_found');
      }
      // The other tenant is untouched.
      const list = (await call('GET', '/api/v1/members', other.headers)).json();
      assert.equal(list.length, 2);
    });

    test('a plain member or viewer calling any member endpoint gets 403', async () => {
      const w = await world();
      for (const who of [w.member, w.viewer]) {
        expectError(await call('GET', '/api/v1/members', who.headers), 403, 'forbidden');
        expectError(
          await call('PATCH', `/api/v1/members/${w.viewer.userId}`, who.headers, { role: 'admin' }),
          403,
          'forbidden'
        );
        expectError(await call('DELETE', `/api/v1/members/${w.viewer.userId}`, who.headers), 403, 'forbidden');
      }
    });

    test('an invalid role is 400 validation_failed', async () => {
      const w = await world();
      expectError(
        await call('PATCH', `/api/v1/members/${w.member.userId}`, w.headers, { role: 'superuser' }),
        400,
        'validation_failed'
      );
      expectError(await call('PATCH', `/api/v1/members/${w.member.userId}`, w.headers, {}), 400, 'validation_failed');
    });
  });

  describe('groups', () => {
    test("an admin sees who is in a group, people and agents by name; others can't", async () => {
      const w = await world();
      const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Scribe' });
      const group = await createGroup(w.headers, 'Writers');
      for (const [type, id] of [['user', w.member.userId], ['agent', agentId], ['user', w.viewer.userId]] as const) {
        const add = await call('POST', `/api/v1/groups/${group.id}/members`, w.headers, { principal_type: type, principal_id: id });
        assert.equal(add.statusCode, 200, add.body);
      }

      const res = await call('GET', `/api/v1/groups/${group.id}/members`, w.admin.headers);
      assert.equal(res.statusCode, 200, res.body);
      const list = res.json() as Array<{ principalType: string; principalId: string; name: string }>;
      assert.deepEqual(
        list.map((m) => `${m.principalType}:${m.principalId}`).sort(),
        [`user:${w.member.userId}`, `agent:${agentId}`, `user:${w.viewer.userId}`].sort(),
      );
      assert.ok(list.find((m) => m.principalId === agentId)?.name === 'Scribe');
      assert.ok(list.every((m) => m.name.length > 0));
      assert.deepEqual(list.map((m) => m.name), [...list.map((m) => m.name)].sort((a, b) => a.localeCompare(b)));

      expectError(await call('GET', `/api/v1/groups/${group.id}/members`, w.member.headers), 403, 'forbidden');
      expectError(await call('GET', '/api/v1/groups/00000000-0000-4000-8000-000000000000/members', w.headers), 404, 'principal_not_found');
    });

    test('create, duplicate name, add member, idempotent re-add, counts and remove', async () => {
      const w = await world();
      const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Scribe' });

      const group = await createGroup(w.headers, '  Writers  ');
      assert.equal(group.name, 'Writers');
      assert.equal(group.memberCount, 0);

      expectError(await call('POST', '/api/v1/groups', w.headers, { name: 'Writers' }), 409, 'group_name_taken');

      const addUser = (type: string, id: string) =>
        call('POST', `/api/v1/groups/${group.id}/members`, w.headers, { principal_type: type, principal_id: id });
      assert.equal((await addUser('user', w.member.userId)).statusCode, 200);
      assert.equal((await addUser('user', w.member.userId)).statusCode, 200); // idempotent
      assert.equal((await addUser('agent', agentId)).statusCode, 200);

      await createGroup(w.headers, 'Empty');
      const list = (await call('GET', '/api/v1/groups', w.headers)).json();
      assert.deepEqual(
        list.map((g: any) => [g.name, g.memberCount]).sort(),
        [
          ['Empty', 0],
          ['Writers', 2],
        ]
      );

      const del = await call('DELETE', `/api/v1/groups/${group.id}/members/user/${w.member.userId}`, w.headers);
      assert.equal(del.statusCode, 204, del.body);
      const again = await call('DELETE', `/api/v1/groups/${group.id}/members/user/${w.member.userId}`, w.headers);
      assert.equal(again.statusCode, 204, again.body);
      const list2 = (await call('GET', '/api/v1/groups', w.headers)).json();
      assert.equal(list2.find((g: any) => g.id === group.id).memberCount, 1);
    });

    test('a group name is unique per tenant only', async () => {
      const w = await world();
      const other = await bootstrapTenant(app, { name: 'Other', slug: 'other' });
      await createGroup(w.headers, 'Writers');
      await createGroup(other.headers, 'Writers');
    });

    test('adding a non-member user, a disabled agent or another tenants principal is 404 principal_not_found', async () => {
      const w = await world();
      const other = await bootstrapTenant(app, { name: 'Other', slug: 'other' });
      const otherMember = await signUpMember(app, other.tenant.id, 'member');
      const otherAgent = await createAgent(other.tenant.id, other.owner.userId);
      const disabled = await createAgent(w.tenant.id, w.owner.userId, { disabled: true });
      const nonMember = await signUp(app);
      const group = await createGroup(w.headers, 'Writers');

      for (const [type, id] of [
        ['user', nonMember.userId],
        ['user', otherMember.userId],
        ['user', other.owner.userId],
        ['user', RANDOM_UUID],
        ['agent', disabled],
        ['agent', otherAgent],
        ['agent', RANDOM_UUID],
      ] as const) {
        expectError(
          await call('POST', `/api/v1/groups/${group.id}/members`, w.headers, { principal_type: type, principal_id: id }),
          404,
          'principal_not_found'
        );
      }
      const list = (await call('GET', '/api/v1/groups', w.headers)).json();
      assert.equal(list[0].memberCount, 0);
    });

    test('an unknown, malformed or other tenants group id is 404 principal_not_found', async () => {
      const w = await world();
      const other = await bootstrapTenant(app, { name: 'Other', slug: 'other' });
      const otherGroup = await createGroup(other.headers, 'Theirs');
      for (const id of [RANDOM_UUID, 'nope', otherGroup.id]) {
        expectError(
          await call('POST', `/api/v1/groups/${id}/members`, w.headers, {
            principal_type: 'user',
            principal_id: w.member.userId,
          }),
          404,
          'principal_not_found'
        );
        expectError(
          await call('DELETE', `/api/v1/groups/${id}/members/user/${w.member.userId}`, w.headers),
          404,
          'principal_not_found'
        );
      }
      // A malformed principal id or type in the path is 404 too.
      const group = await createGroup(w.headers, 'Writers');
      expectError(
        await call('DELETE', `/api/v1/groups/${group.id}/members/user/nope`, w.headers),
        404,
        'principal_not_found'
      );
      expectError(
        await call('DELETE', `/api/v1/groups/${group.id}/members/group/${w.member.userId}`, w.headers),
        404,
        'principal_not_found'
      );
    });

    test('validation errors are 400 validation_failed', async () => {
      const w = await world();
      const group = await createGroup(w.headers, 'Writers');
      expectError(await call('POST', '/api/v1/groups', w.headers, { name: '   ' }), 400, 'validation_failed');
      expectError(await call('POST', '/api/v1/groups', w.headers, { name: 'x'.repeat(121) }), 400, 'validation_failed');
      expectError(await call('POST', '/api/v1/groups', w.headers, {}), 400, 'validation_failed');
      expectError(
        await call('POST', `/api/v1/groups/${group.id}/members`, w.headers, {
          principal_type: 'group',
          principal_id: group.id,
        }),
        400,
        'validation_failed'
      );
      expectError(
        await call('POST', `/api/v1/groups/${group.id}/members`, w.headers, {
          principal_type: 'user',
          principal_id: 'nope',
        }),
        400,
        'validation_failed'
      );
    });

    test('a plain member calling any group endpoint gets 403', async () => {
      const w = await world();
      const group = await createGroup(w.headers, 'Writers');
      expectError(await call('GET', '/api/v1/groups', w.member.headers), 403, 'forbidden');
      expectError(await call('POST', '/api/v1/groups', w.member.headers, { name: 'X' }), 403, 'forbidden');
      expectError(
        await call('POST', `/api/v1/groups/${group.id}/members`, w.member.headers, {
          principal_type: 'user',
          principal_id: w.member.userId,
        }),
        403,
        'forbidden'
      );
      expectError(
        await call('DELETE', `/api/v1/groups/${group.id}/members/user/${w.member.userId}`, w.member.headers),
        403,
        'forbidden'
      );
    });

    test('a tenant admin (not owner) can manage groups', async () => {
      const w = await world();
      const group = await createGroup(w.admin.headers, 'Writers');
      const res = await call('POST', `/api/v1/groups/${group.id}/members`, w.admin.headers, {
        principal_type: 'user',
        principal_id: w.member.userId,
      });
      assert.equal(res.statusCode, 200, res.body);
    });
  });

  describe('space grants', () => {
    test('the list shows user, group and agent grants with their names', async () => {
      const w = await world();
      const space = await createSpace(w);
      const group = await createGroup(w.headers, 'Writers');
      const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Scribe' });
      await grant(w, space.id, 'user', w.member.userId, 'editor');
      await grant(w, space.id, 'group', group.id, 'reviewer');
      await grant(w, space.id, 'agent', agentId, 'viewer');

      const res = await call('GET', `/api/v1/spaces/${space.id}/grants`, w.headers);
      assert.equal(res.statusCode, 200, res.body);
      const sorted = res.json().sort((a: any, b: any) => a.principalType.localeCompare(b.principalType));
      assert.deepEqual(sorted, [
        { principalType: 'agent', principalId: agentId, principalName: 'Scribe', role: 'viewer' },
        { principalType: 'group', principalId: group.id, principalName: 'Writers', role: 'reviewer' },
        { principalType: 'user', principalId: w.member.userId, principalName: 'member', role: 'editor' },
      ]);
    });

    test('deleting a grant removes that users access to the space and is audited', async () => {
      const w = await world();
      const space = await createSpace(w);
      await grant(w, space.id, 'user', w.member.userId, 'editor');
      assert.equal((await call('GET', `/api/v1/spaces/${space.id}`, w.member.headers)).statusCode, 200);

      const del = await call('DELETE', `/api/v1/spaces/${space.id}/grants/user/${w.member.userId}`, w.headers);
      assert.equal(del.statusCode, 204, del.body);
      expectError(await call('GET', `/api/v1/spaces/${space.id}`, w.member.headers), 404, 'space_not_found');
      assert.deepEqual((await call('GET', `/api/v1/spaces/${space.id}/grants`, w.headers)).json(), []);

      const events = (await auditTypes(w.tenant.id, 'space.grant_changed')).filter(
        (e) => (e.payload as any).removed === true
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].subjectId, space.id);
      assert.equal(events[0].actorId, w.owner.userId);
      assert.deepEqual(events[0].payload, {
        removed: true,
        principalType: 'user',
        principalId: w.member.userId,
      });

      expectError(
        await call('DELETE', `/api/v1/spaces/${space.id}/grants/user/${w.member.userId}`, w.headers),
        404,
        'principal_not_found'
      );
    });

    test('a space admin without a tenant admin role can list and delete grants; a plain editor cannot', async () => {
      const w = await world();
      const space = await createSpace(w);
      await grant(w, space.id, 'user', w.member.userId, 'admin');
      await grant(w, space.id, 'user', w.viewer.userId, 'viewer');

      const list = await call('GET', `/api/v1/spaces/${space.id}/grants`, w.member.headers);
      assert.equal(list.statusCode, 200, list.body);
      expectError(await call('GET', `/api/v1/spaces/${space.id}/grants`, w.viewer.headers), 403, 'forbidden');
      expectError(
        await call('DELETE', `/api/v1/spaces/${space.id}/grants/user/${w.viewer.userId}`, w.viewer.headers),
        403,
        'forbidden'
      );
      const del = await call('DELETE', `/api/v1/spaces/${space.id}/grants/user/${w.viewer.userId}`, w.member.headers);
      assert.equal(del.statusCode, 204, del.body);
    });

    test('a member without any grant gets 404 and another tenants or malformed ids are 404', async () => {
      const w = await world();
      const space = await createSpace(w);
      const other = await bootstrapTenant(app, { name: 'Other', slug: 'other' });

      expectError(await call('GET', `/api/v1/spaces/${space.id}/grants`, w.member.headers), 404, 'space_not_found');
      expectError(await call('GET', `/api/v1/spaces/${space.id}/grants`, other.headers), 404, 'space_not_found');
      expectError(await call('GET', `/api/v1/spaces/${RANDOM_UUID}/grants`, w.headers), 404, 'space_not_found');
      expectError(await call('GET', '/api/v1/spaces/nope/grants', w.headers), 404, 'space_not_found');
      expectError(
        await call('DELETE', `/api/v1/spaces/nope/grants/user/${w.member.userId}`, w.headers),
        404,
        'space_not_found'
      );
      expectError(
        await call('DELETE', `/api/v1/spaces/${space.id}/grants/user/nope`, w.headers),
        404,
        'principal_not_found'
      );
      expectError(
        await call('DELETE', `/api/v1/spaces/${space.id}/grants/robot/${w.member.userId}`, w.headers),
        404,
        'principal_not_found'
      );
    });
  });

  test('every admin endpoint requires a session in the tenant', async () => {
    const w = await world();
    const stranger = await signUp(app);
    expectError(await call('GET', '/api/v1/members', asUser(stranger, w.tenant.id)), 404, 'tenant_not_found');
    expectError(await call('GET', '/api/v1/groups', {}), 401, 'unauthenticated');
  });
});
