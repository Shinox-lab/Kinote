import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { agents, auditEvents, tenantBilling, withTenantTx } from '@kinote/db';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';
import { bearer } from './support/sourcekit.js';

describe('agents admin API', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
    app.get('/test/agent-whoami', { config: { auth: 'agent' } }, async (req) => ({ actor: req.actor }));
  });

  type H = Record<string, string>;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: H, payload?: object) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

  async function world(slug: string) {
    const t = await bootstrapTenant(app, { name: `${slug} Co`, slug });
    const space = await call('POST', '/api/v1/spaces', t.headers, { name: 'Docs', slug: 'docs' });
    assert.equal(space.statusCode, 201, space.body);
    return { ...t, space: space.json() as { id: string } };
  }

  async function createAgent(headers: H, body: object = { name: 'Docs bot' }) {
    const res = await call('POST', '/api/v1/agents', headers, body);
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  }

  async function issue(headers: H, agentId: string, body: object = { name: 'laptop', scopes: ['read'] }) {
    return call('POST', `/api/v1/agents/${agentId}/tokens`, headers, body);
  }

  test('an admin creates an agent, grants it a space, issues a token; the token signs in', async () => {
    const w = await world('adm-flow');
    const agent = await createAgent(w.headers);
    assert.equal(agent.name, 'Docs bot');
    assert.equal(agent.owner.id, w.owner.userId);
    assert.equal(agent.owner.role, 'owner');
    assert.equal(agent.disabledAt, null);
    assert.equal(agent.dailyAiLimit, null);
    assert.deepEqual(agent.tokens, []);

    const grant = await call('POST', `/api/v1/spaces/${w.space.id}/grants`, w.headers, {
      principal_type: 'agent',
      principal_id: agent.id,
      role: 'viewer',
    });
    assert.equal(grant.statusCode, 201, grant.body);

    const issued = await issue(w.headers, agent.id);
    assert.equal(issued.statusCode, 201, issued.body);
    const { token, info } = issued.json();
    assert.match(token, /^lwagt_/);
    assert.equal(info.name, 'laptop');
    assert.deepEqual(info.scopes, ['read']);
    assert.equal(info.prefix, token.split('.')[1].slice(0, 8));

    const who = await call('GET', '/test/agent-whoami', bearer(token));
    assert.equal(who.statusCode, 200, who.body);
    assert.equal(who.json().actor.principalId, agent.id);

    const list = await call('GET', '/api/v1/agents', w.headers);
    assert.equal(list.statusCode, 200, list.body);
    const [listed] = list.json();
    assert.deepEqual(listed.grants, [{ spaceId: w.space.id, spaceName: 'Docs', role: 'viewer' }]);

    const types = (
      await withTenantTx(w.tenant.id, (tx) => tx.select({ type: auditEvents.type }).from(auditEvents).where(eq(auditEvents.subjectId, agent.id)))
    ).map((r) => r.type);
    assert.ok(types.includes('agent.created'));
    assert.ok(types.includes('agent.token_issued'));
  });

  test('the token secret appears only in the issue reply', async () => {
    const w = await world('adm-secret');
    const agent = await createAgent(w.headers);
    const { token } = (await issue(w.headers, agent.id)).json();
    const list = await call('GET', '/api/v1/agents', w.headers);
    assert.ok(!list.body.includes(token));
    assert.ok(!list.body.includes(token.split('.')[1]));
    const [listed] = list.json();
    assert.equal(listed.tokens.length, 1);
    assert.equal(listed.tokens[0].token, undefined);
    assert.equal(listed.tokens[0].prefix.length, 8);
  });

  test('expiry defaults to 90 days, and expires_in_days sets it', async () => {
    const w = await world('adm-expiry');
    const agent = await createAgent(w.headers);
    const a = (await issue(w.headers, agent.id)).json().info;
    assert.ok(Math.abs(new Date(a.expiresAt).getTime() - (Date.now() + 90 * 86_400_000)) < 60_000);
    const b = (await issue(w.headers, agent.id, { name: 'short', scopes: ['read'], expires_in_days: 3 })).json().info;
    assert.ok(Math.abs(new Date(b.expiresAt).getTime() - (Date.now() + 3 * 86_400_000)) < 60_000);
    assert.equal((await issue(w.headers, agent.id, { name: 'x', scopes: ['read'], expires_in_days: 366 })).statusCode, 400);
  });

  test('scopes must be a non-empty subset of read, capture, edit', async () => {
    const w = await world('adm-scopes');
    const agent = await createAgent(w.headers);
    for (const scopes of [[], ['admin'], ['read', 'read']]) {
      const res = await issue(w.headers, agent.id, { name: 'x', scopes });
      assert.equal(res.statusCode, 400, `${JSON.stringify(scopes)}: ${res.body}`);
    }
    const ok = await issue(w.headers, agent.id, { name: 'x', scopes: ['read', 'capture', 'edit'] });
    assert.equal(ok.statusCode, 201, ok.body);
  });

  test('a member gets 403 on every agents route', async () => {
    const w = await world('adm-member');
    const agent = await createAgent(w.headers);
    const tokenId = (await issue(w.headers, agent.id)).json().info.id;
    const member = await signUpMember(app, w.tenant.id, 'member');
    const attempts = [
      call('GET', '/api/v1/agents', member.headers),
      call('POST', '/api/v1/agents', member.headers, { name: 'Mine' }),
      call('PATCH', `/api/v1/agents/${agent.id}`, member.headers, { name: 'Renamed' }),
      issue(member.headers, agent.id),
      call('DELETE', `/api/v1/agents/${agent.id}/tokens/${tokenId}`, member.headers),
    ];
    for (const res of await Promise.all(attempts)) {
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(res.json().error, 'forbidden');
    }
  });

  test("another tenant's agent id gets 404 agent_not_found", async () => {
    const a = await world('adm-a');
    const b = await world('adm-b');
    const agent = await createAgent(a.headers);
    for (const res of [
      await call('PATCH', `/api/v1/agents/${agent.id}`, b.headers, { name: 'Mine now' }),
      await issue(b.headers, agent.id),
      await call('PATCH', '/api/v1/agents/not-a-uuid', b.headers, { name: 'x' }),
    ]) {
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error, 'agent_not_found');
    }
  });

  test('disabling an agent makes its token answer 401; enabling restores it', async () => {
    const w = await world('adm-disable');
    const agent = await createAgent(w.headers);
    const { token } = (await issue(w.headers, agent.id)).json();
    const off = await call('PATCH', `/api/v1/agents/${agent.id}`, w.headers, { disabled: true });
    assert.equal(off.statusCode, 200, off.body);
    assert.ok(off.json().disabledAt);
    assert.equal((await call('GET', '/test/agent-whoami', bearer(token))).statusCode, 401);
    const on = await call('PATCH', `/api/v1/agents/${agent.id}`, w.headers, { disabled: false });
    assert.equal(on.json().disabledAt, null);
    assert.equal((await call('GET', '/test/agent-whoami', bearer(token))).statusCode, 200);
  });

  test('rename and daily AI limit, with an audit row', async () => {
    const w = await world('adm-update');
    const agent = await createAgent(w.headers, { name: 'Bot', daily_ai_limit: 20 });
    assert.equal(agent.dailyAiLimit, 20);
    const res = await call('PATCH', `/api/v1/agents/${agent.id}`, w.headers, { name: 'Bot 2', daily_ai_limit: null });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().name, 'Bot 2');
    assert.equal(res.json().dailyAiLimit, null);
    assert.equal((await call('PATCH', `/api/v1/agents/${agent.id}`, w.headers, { daily_ai_limit: 0 })).statusCode, 400);
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.subjectId, agent.id), eq(auditEvents.type, 'agent.updated')))
    );
    assert.equal(rows.length, 1);
  });

  test('revoking twice returns the same revokedAt, and the token stops working', async () => {
    const w = await world('adm-revoke');
    const agent = await createAgent(w.headers);
    const { token, info } = (await issue(w.headers, agent.id)).json();
    const first = await call('DELETE', `/api/v1/agents/${agent.id}/tokens/${info.id}`, w.headers);
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(first.json().revokedAt);
    const second = await call('DELETE', `/api/v1/agents/${agent.id}/tokens/${info.id}`, w.headers);
    assert.equal(second.json().revokedAt, first.json().revokedAt);
    assert.equal((await call('GET', '/test/agent-whoami', bearer(token))).statusCode, 401);
    const revokedRows = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.subjectId, agent.id), eq(auditEvents.type, 'agent.token_revoked')))
    );
    assert.equal(revokedRows.length, 1);
  });

  test('agents list newest first', async () => {
    const w = await world('adm-order');
    await createAgent(w.headers, { name: 'First' });
    await createAgent(w.headers, { name: 'Second' });
    const names = (await call('GET', '/api/v1/agents', w.headers)).json().map((a: { name: string }) => a.name);
    assert.deepEqual(names, ['Second', 'First']);
  });

  test('while the workspace is suspended, an admin can still revoke a token and disable an agent, but not rename it', async () => {
    const w = await world('adm-suspended');
    const agent = await createAgent(w.headers);
    const a = (await issue(w.headers, agent.id)).json();
    await withTenantTx(w.tenant.id, (tx) =>
      tx.insert(tenantBilling).values({ tenantId: w.tenant.id, state: 'suspended' }).onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
    const revoked = await call('DELETE', `/api/v1/agents/${agent.id}/tokens/${a.info.id}`, w.headers);
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal((await call('GET', '/test/agent-whoami', bearer(a.token))).statusCode, 401);
    const off = await call('PATCH', `/api/v1/agents/${agent.id}`, w.headers, { disabled: true });
    assert.equal(off.statusCode, 200, off.body);
    const rename = await call('PATCH', `/api/v1/agents/${agent.id}`, w.headers, { name: 'New name' });
    assert.equal(rename.statusCode, 423, rename.body);
    const on = await call('PATCH', `/api/v1/agents/${agent.id}`, w.headers, { disabled: false });
    assert.equal(on.statusCode, 423, on.body);
  });

  test('the built-in routing engine is not a manageable agent', async () => {
    const w = await world('adm-router');
    const [router] = await withTenantTx(w.tenant.id, (tx) =>
      tx
        .insert(agents)
        .values({ tenantId: w.tenant.id, name: 'Routing engine', kind: 'router', createdBy: '00000000-0000-0000-0000-000000000000' })
        .returning()
    );
    const list = (await call('GET', '/api/v1/agents', w.headers)).json();
    assert.ok(!list.some((a: { id: string }) => a.id === router!.id));
    for (const res of [
      await call('PATCH', `/api/v1/agents/${router!.id}`, w.headers, { name: 'Mine' }),
      await issue(w.headers, router!.id),
    ]) {
      assert.equal(res.statusCode, 404, res.body);
      assert.equal(res.json().error, 'agent_not_found');
    }
  });
});
