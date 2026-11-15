import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { withTenantTx } from '@kinote/db';
import { getReadableSpaceIds, ownerActorOf, requireSpaceRole, type Actor } from '@kinote/core';
import { buildTestApp, createAgent, setMemberRole, signUpMember, useTestDb } from './support/testkit.js';
import { agentWorld } from './support/mcpkit.js';

type App = ReturnType<typeof buildTestApp>;

async function grant(app: App, headers: Record<string, string>, spaceId: string, type: 'user' | 'agent', id: string, role: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/spaces/${spaceId}/grants`,
    headers,
    payload: { principal_type: type, principal_id: id, role },
  });
  assert.equal(res.statusCode, 201, res.body);
}

const agentActor = (tenantId: string, agentId: string, ownerId: string, role: 'owner' | 'admin' | 'member' | 'viewer'): Actor => ({
  tenantId,
  principalType: 'agent',
  principalId: agentId,
  owner: { userId: ownerId, tenantRole: role },
});

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => e?.code === code);
}

describe('an agent never exceeds its owner', () => {
  let app: App;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
  });

  /** An agent owned by a plain member, with editor grants on Open and Strict. */
  async function memberOwnedAgent(slug: string) {
    const w = await agentWorld(app, slug);
    const member = await signUpMember(app, w.tenant.id, 'member');
    const agentId = await createAgent(w.tenant.id, member.userId, { name: 'Member bot' });
    for (const s of [w.open, w.strict, w.hidden]) await grant(app, w.ownerHeaders, s.id, 'agent', agentId, 'editor');
    return { ...w, member, memberAgentId: agentId };
  }

  test('ownerActorOf is null for users and the owner as a user for agents', () => {
    assert.equal(ownerActorOf({ tenantId: 't', principalType: 'user', principalId: 'u', tenantRole: 'member' }), null);
    assert.deepEqual(ownerActorOf(agentActor('t', 'a', 'u', 'admin')), {
      tenantId: 't',
      principalType: 'user',
      principalId: 'u',
      tenantRole: 'admin',
    });
  });

  test('owner is viewer where the agent is editor: editor refused, viewer passes', async () => {
    const w = await memberOwnedAgent('limit-viewer');
    await grant(app, w.ownerHeaders, w.open.id, 'user', w.member.userId, 'viewer');
    const actor = agentActor(w.tenant.id, w.memberAgentId, w.member.userId, 'member');
    await withTenantTx(w.tenant.id, async (tx) => {
      await rejectsWith(requireSpaceRole(tx, actor, w.open.id, 'editor'), 'forbidden');
      const access = await requireSpaceRole(tx, actor, w.open.id, 'viewer');
      assert.equal(access.effectiveRole, 'viewer');
    });
  });

  test('owner has no grant: space_not_found, and the space is not readable', async () => {
    const w = await memberOwnedAgent('limit-none');
    await grant(app, w.ownerHeaders, w.open.id, 'user', w.member.userId, 'editor');
    const actor = agentActor(w.tenant.id, w.memberAgentId, w.member.userId, 'member');
    await withTenantTx(w.tenant.id, async (tx) => {
      await rejectsWith(requireSpaceRole(tx, actor, w.strict.id, 'viewer'), 'space_not_found');
      const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
      assert.deepEqual(new Set(readableSpaceIds), new Set([w.open.id, inboxSpaceId]));
    });
  });

  test('owner demoted from admin to member: the next call loses what the member cannot read', async () => {
    const w = await memberOwnedAgent('limit-demote');
    await setMemberRole(w.tenant.id, w.member.userId, 'admin');
    const asAdmin = agentActor(w.tenant.id, w.memberAgentId, w.member.userId, 'admin');
    const before = await withTenantTx(w.tenant.id, (tx) => getReadableSpaceIds(tx, asAdmin));
    assert.ok(before.readableSpaceIds.includes(w.hidden.id));
    await setMemberRole(w.tenant.id, w.member.userId, 'member');
    const asMember = agentActor(w.tenant.id, w.memberAgentId, w.member.userId, 'member');
    const after = await withTenantTx(w.tenant.id, (tx) => getReadableSpaceIds(tx, asMember));
    assert.deepEqual(after.readableSpaceIds, [after.inboxSpaceId]);
  });

  test("an agent's own grants still bound it under an all-seeing owner", async () => {
    const w = await agentWorld(app, 'limit-own');
    const actor = agentActor(w.tenant.id, w.agentId, w.owner.userId, 'owner');
    await withTenantTx(w.tenant.id, async (tx) => {
      const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
      assert.deepEqual(new Set(readableSpaceIds), new Set([w.open.id, w.strict.id, inboxSpaceId]));
      const access = await requireSpaceRole(tx, actor, w.open.id, 'editor');
      assert.equal(access.effectiveRole, 'editor');
      await rejectsWith(requireSpaceRole(tx, actor, w.hidden.id, 'viewer'), 'space_not_found');
    });
  });

  test('a user actor is unchanged', async () => {
    const w = await agentWorld(app, 'limit-user');
    const member = await signUpMember(app, w.tenant.id, 'member');
    await grant(app, w.ownerHeaders, w.open.id, 'user', member.userId, 'editor');
    const owner: Actor = { tenantId: w.tenant.id, principalType: 'user', principalId: w.owner.userId, tenantRole: 'owner' };
    const m: Actor = { tenantId: w.tenant.id, principalType: 'user', principalId: member.userId, tenantRole: 'member' };
    await withTenantTx(w.tenant.id, async (tx) => {
      assert.equal((await requireSpaceRole(tx, owner, w.hidden.id, 'admin')).effectiveRole, 'admin');
      assert.equal((await requireSpaceRole(tx, m, w.open.id, 'editor')).effectiveRole, 'editor');
      const r = await getReadableSpaceIds(tx, m);
      assert.deepEqual(new Set(r.readableSpaceIds), new Set([w.open.id, r.inboxSpaceId]));
    });
  });
});
