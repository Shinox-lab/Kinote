import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { agentTokens, withTenantTx } from '@kinote/db';
import { DEFAULT_AGENT_TOKEN_DAYS, type AgentScope } from '@kinote/contracts';
import { mintAgentToken } from '../../src/auth/agentTokens.js';
import { bootstrapTenant, createAgent } from './testkit.js';

/**
 * Writes an agent token row directly (tests that are not about the admin routes) and returns the
 * token and its id. Default: scopes ['read'], expiring in 90 days.
 */
export async function issueAgentToken(
  tenantId: string,
  agentId: string,
  opts: { scopes?: AgentScope[]; expiresAt?: Date | null; createdBy?: string; name?: string } = {}
): Promise<{ token: string; tokenId: string }> {
  const minted = mintAgentToken(tenantId);
  const expiresAt =
    opts.expiresAt === undefined ? new Date(Date.now() + DEFAULT_AGENT_TOKEN_DAYS * 86_400_000) : opts.expiresAt;
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .insert(agentTokens)
      .values({
        tenantId,
        agentId,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
        name: opts.name ?? 'test',
        scopes: opts.scopes ?? ['read'],
        expiresAt,
        createdBy: opts.createdBy ?? null,
      })
      .returning({ id: agentTokens.id })
  );
  return { token: minted.token, tokenId: row!.id };
}

/**
 * A tenant with three spaces (Open, Strict with review, Hidden) and one agent owned by the tenant
 * owner, granted `editor` on Open and Strict and nothing on Hidden, with one `read` token.
 */
export async function agentWorld(app: FastifyInstance, slug = 'agent-world') {
  const { tenant, owner, inboxSpace, headers: ownerHeaders } = await bootstrapTenant(app, { name: `${slug} Co`, slug });
  const mk = async (name: string, review: boolean) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: ownerHeaders,
      payload: { name, slug: name.toLowerCase(), review_required: review },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { id: string; name: string };
  };
  const open = await mk('Open', false);
  const strict = await mk('Strict', true);
  const hidden = await mk('Hidden', false);
  const agentId = await createAgent(tenant.id, owner.userId, { name: 'Test agent' });
  for (const space of [open, strict]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/spaces/${space.id}/grants`,
      headers: ownerHeaders,
      payload: { principal_type: 'agent', principal_id: agentId, role: 'editor' },
    });
    assert.equal(res.statusCode, 201, res.body);
  }
  const { token, tokenId } = await issueAgentToken(tenant.id, agentId, { createdBy: owner.userId });
  return { tenant, owner, ownerHeaders, inboxSpace, open, strict, hidden, agentId, token, tokenId };
}
export type AgentWorld = Awaited<ReturnType<typeof agentWorld>>;
