import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { agentTokens, agents, withTenantTx } from '@kinote/db';
import { sha256Hex } from '@kinote/shared';
import { AGENT_SCOPES, DEFAULT_AGENT_TOKEN_DAYS } from '@kinote/contracts';
import {
  mintAgentToken,
  mintOAuthCode,
  mintRefreshToken,
  parseAgentToken,
  parseOAuthCode,
  parseRefreshToken,
  AGENT_TOKEN_PREFIX,
} from '../src/auth/agentTokens.js';
import { mintSourceToken } from '../src/auth/sourceTokens.js';
import { bootstrapTenant, buildTestApp, createAgent, useTestDb } from './support/testkit.js';

const TENANT = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('agent tokens', () => {
  test('a minted token parses back to its tenant and hash', () => {
    const t = mintAgentToken(TENANT);
    assert.equal(AGENT_TOKEN_PREFIX, 'lwagt_');
    assert.match(t.token, /^lwagt_0f8fad5bd9cb469fa16570867728950e\.[A-Za-z0-9_-]{43}$/);
    assert.equal(t.hash, sha256Hex(t.token));
    assert.deepEqual(parseAgentToken(t.token), { tenantId: TENANT, hash: t.hash });
    assert.equal(t.prefix, t.token.split('.')[1]!.slice(0, 8));
  });

  test('source and session tokens are not agent tokens', () => {
    assert.equal(parseAgentToken(mintSourceToken(TENANT).token), null);
    assert.equal(parseAgentToken('lws_abc'), null);
    assert.equal(parseAgentToken('lwagt_xyz.abc'), null);
    const good = mintAgentToken(TENANT).token;
    assert.equal(parseAgentToken(`${good} `), null);
    assert.equal(parseAgentToken(good.replace('lwagt_', 'LWAGT_')), null);
  });

  test('refresh tokens (lwagr_) and authorization codes (lwaco_) carry their tenant and are never mistaken for each other', () => {
    const r = mintRefreshToken(TENANT);
    assert.match(r.token, /^lwagr_0f8fad5bd9cb469fa16570867728950e\.[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(parseRefreshToken(r.token), { tenantId: TENANT, hash: sha256Hex(r.token) });
    const c = mintOAuthCode(TENANT);
    assert.match(c.token, /^lwaco_0f8fad5bd9cb469fa16570867728950e\.[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(parseOAuthCode(c.token), { tenantId: TENANT, hash: sha256Hex(c.token) });
    const a = mintAgentToken(TENANT).token;
    for (const [parse, others] of [
      [parseAgentToken, [r.token, c.token]],
      [parseRefreshToken, [a, c.token]],
      [parseOAuthCode, [a, r.token]],
    ] as const) {
      for (const other of others) assert.equal(parse(other), null, other);
    }
  });

  test('scopes and default expiry', () => {
    assert.deepEqual([...AGENT_SCOPES], ['read', 'capture', 'edit']);
    assert.equal(DEFAULT_AGENT_TOKEN_DAYS, 90);
  });
});

describe('agent token columns', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    app = buildTestApp();
  });

  test('migration adds the token columns and the agent limit', async () => {
    const { owner, tenant } = await bootstrapTenant(app, { name: 'Tok', slug: 'tok' });
    const agentId = await createAgent(tenant.id, owner.userId);
    const minted = mintAgentToken(tenant.id);
    await withTenantTx(tenant.id, async (tx) => {
      await tx.update(agents).set({ dailyAiLimit: 7 }).where(eq(agents.id, agentId));
      await tx.insert(agentTokens).values({
        tenantId: tenant.id,
        agentId,
        tokenHash: minted.hash,
        scopes: ['read'],
        name: 'laptop',
        tokenPrefix: minted.prefix,
        createdBy: owner.userId,
      });
    });
    const [row] = await withTenantTx(tenant.id, (tx) => tx.select().from(agentTokens).where(eq(agentTokens.agentId, agentId)));
    assert.equal(row!.name, 'laptop');
    assert.equal(row!.tokenPrefix, minted.prefix);
    assert.equal(row!.createdBy, owner.userId);
    const [agent] = await withTenantTx(tenant.id, (tx) => tx.select().from(agents).where(eq(agents.id, agentId)));
    assert.equal(agent!.dailyAiLimit, 7);

    await assert.rejects(
      withTenantTx(tenant.id, (tx) =>
        tx.insert(agentTokens).values({ tenantId: tenant.id, agentId, tokenHash: minted.hash, scopes: ['read'] })
      ),
      (e: any) => /agent_tokens_tenant_hash_idx/.test(String(e?.cause?.message ?? e?.message))
    );
  });

  test('scopes must be a non-empty subset of read, capture, edit', async () => {
    const { owner, tenant } = await bootstrapTenant(app, { name: 'Tok', slug: 'tok' });
    const agentId = await createAgent(tenant.id, owner.userId);
    for (const scopes of [[], ['admin'], ['read', 'write']]) {
      await assert.rejects(
        withTenantTx(tenant.id, (tx) =>
          tx.insert(agentTokens).values({ tenantId: tenant.id, agentId, tokenHash: mintAgentToken(tenant.id).hash, scopes })
        ),
        (e: any) => /agent_tokens_scopes_check/.test(String(e?.cause?.message ?? e?.message)),
        JSON.stringify(scopes)
      );
    }
  });
});
