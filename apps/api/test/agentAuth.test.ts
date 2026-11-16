import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { agentTokens, agents, memberships, tenants, withTenantTx } from '@kinote/db';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, issueAgentToken } from './support/mcpkit.js';
import { bearer, makeSource } from './support/sourcekit.js';

describe('agent token sign-in', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
    app.get('/test/agent-whoami', { config: { auth: 'agent' } }, async (req) => ({
      actor: req.actor,
      agent: req.agentAuth,
    }));
  });

  const whoami = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/test/agent-whoami', headers });

  test('a valid token resolves to the agent, with its owner', async () => {
    const w = await agentWorld(app, 'whoami');
    const res = await whoami(bearer(w.token));
    assert.equal(res.statusCode, 200, res.body);
    const { actor, agent } = res.json();
    assert.equal(actor.tenantId, w.tenant.id);
    assert.equal(actor.principalType, 'agent');
    assert.equal(actor.principalId, w.agentId);
    assert.equal(actor.tenantRole, undefined);
    assert.deepEqual(actor.owner, { userId: w.owner.userId, tenantRole: 'owner' });
    assert.equal(agent.agentId, w.agentId);
    assert.equal(agent.agentName, 'Test agent');
    assert.equal(agent.tokenId, w.tokenId);
    assert.deepEqual(agent.scopes, ['read']);
    assert.equal(agent.tenantSlug, 'whoami');
    assert.equal(agent.dailyAiLimit, null);
  });

  test('every way of failing answers the same 401', async () => {
    const w = await agentWorld(app, 'fail-a');
    const other = await agentWorld(app, 'fail-b');
    const [head, secret] = w.token.split('.') as [string, string];
    const src = await makeSource(app, w.ownerHeaders, { name: 'Feed', spaceId: w.open.id });
    const revoked = await issueAgentToken(w.tenant.id, w.agentId);
    await withTenantTx(w.tenant.id, (tx) => tx.update(agentTokens).set({ revokedAt: new Date() }).where(eq(agentTokens.id, revoked.tokenId)));
    const expired = await issueAgentToken(w.tenant.id, w.agentId, { expiresAt: new Date(Date.now() - 1000) });

    const disabledWorld = await agentWorld(app, 'fail-disabled');
    await withTenantTx(disabledWorld.tenant.id, (tx) => tx.update(agents).set({ disabledAt: new Date() }).where(eq(agents.id, disabledWorld.agentId)));

    // The owner's membership is gone.
    const leaver = await agentWorld(app, 'fail-leaver');
    await withTenantTx(leaver.tenant.id, (tx) =>
      tx.delete(memberships).where(and(eq(memberships.tenantId, leaver.tenant.id), eq(memberships.userId, leaver.owner.userId)))
    );

    const gone = await agentWorld(app, 'fail-gone');
    await withTenantTx(gone.tenant.id, (tx) => tx.update(tenants).set({ deletedAt: new Date() }).where(eq(tenants.id, gone.tenant.id)));

    const attempts: Array<[string, Record<string, string>]> = [
      ['no header', {}],
      ['bare Bearer', { authorization: 'Bearer' }],
      ['a session token', bearer(w.owner.token)],
      ['a source token', bearer(src.token)],
      ['garbage', bearer('nonsense')],
      ['unknown tenant', bearer(`${head.slice(0, 6)}${'0'.repeat(32)}.${secret}`)],
      ["tenant A's token with tenant B's id", bearer(`${head.slice(0, 6)}${other.tenant.id.replaceAll('-', '')}.${secret}`)],
      ['altered secret', bearer(`${head}.${secret.slice(0, 42)}${secret.endsWith('A') ? 'B' : 'A'}`)],
      ['revoked', bearer(revoked.token)],
      ['expired', bearer(expired.token)],
      ['agent disabled', bearer(disabledWorld.token)],
      ['owner removed', bearer(leaver.token)],
      ['tenant deleted', bearer(gone.token)],
    ];
    const bodies = new Set<string>();
    for (const [label, headers] of attempts) {
      const res = await whoami(headers);
      assert.equal(res.statusCode, 401, `${label}: ${res.body}`);
      assert.equal(res.json().error, 'unauthenticated', label);
      bodies.add(res.body);
    }
    assert.equal(bodies.size, 1, `bodies differ: ${[...bodies].join(' | ')}`);
  });

  test('an agent token opens no session route', async () => {
    const w = await agentWorld(app, 'no-session');
    const res = await app.inject({ method: 'GET', url: '/api/v1/spaces', headers: { ...bearer(w.token), 'x-tenant-id': w.tenant.id } });
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(res.json().error, 'unauthenticated');
  });

  test("the owner's role is read on every call", async () => {
    const w = await agentWorld(app, 'role-now');
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(memberships).set({ role: 'member' }).where(and(eq(memberships.tenantId, w.tenant.id), eq(memberships.userId, w.owner.userId)))
    );
    const res = await whoami(bearer(w.token));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().actor.owner.tenantRole, 'member');
  });

  test('last_used_at moves at most once a minute', async () => {
    const w = await agentWorld(app, 'last-used');
    const read = async () =>
      (await withTenantTx(w.tenant.id, (tx) => tx.select().from(agentTokens).where(eq(agentTokens.id, w.tokenId))))[0]!.lastUsedAt;
    assert.equal(await read(), null);
    assert.equal((await whoami(bearer(w.token))).statusCode, 200);
    const first = await read();
    assert.ok(first);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await whoami(bearer(w.token))).statusCode, 200);
    assert.equal((await read())!.getTime(), first.getTime());
  });
});
