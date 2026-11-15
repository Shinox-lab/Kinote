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

let rpcId = 0;

/** POSTs one JSON-RPC 2.0 request to the MCP endpoint (stateless: no initialize needed first). */
export async function mcpRequest(
  app: FastifyInstance,
  token: string,
  method: string,
  params?: object,
  path = '/mcp'
): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) },
  });
  let body: any = res.body;
  try {
    body = res.json();
  } catch {
    // Not JSON (an empty 202, say): the raw text.
  }
  return { status: res.statusCode, body, headers: res.headers };
}

/** Calls one tool and returns its text and error flag. */
export async function callTool(
  app: FastifyInstance,
  token: string,
  name: string,
  args: object = {},
  path = '/mcp'
): Promise<{ text: string; isError: boolean }> {
  const res = await mcpRequest(app, token, 'tools/call', { name, arguments: args }, path);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.result, JSON.stringify(res.body));
  const content = res.body.result.content as Array<{ type: string; text: string }>;
  return { text: content.map((c) => c.text).join('\n'), isError: res.body.result.isError === true };
}

/** The tool names `tools/list` shows this token. */
export async function listToolNames(app: FastifyInstance, token: string, path = '/mcp'): Promise<string[]> {
  const res = await mcpRequest(app, token, 'tools/list', undefined, path);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
}

/**
 * Creates a page in a space without review and snapshots it, so the next `indexAll` indexes it.
 * Returns the page id.
 */
export async function publishPage(
  app: FastifyInstance,
  headers: Record<string, string>,
  spaceId: string,
  title: string,
  markdown: string,
  parentId: string | null = null
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/pages',
    headers,
    payload: { space_id: spaceId, parent_id: parentId, title, slug: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${++rpcId}`, markdown },
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().id as string;
  const snap = await app.inject({ method: 'POST', url: `/api/v1/pages/${id}/snapshot`, headers });
  assert.ok(snap.statusCode < 300, snap.body);
  return id;
}

/** A result with its `<kinote:content …>` and `</kinote:content>` tag lines removed (for asserting on the text). */
export function unwrap(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^<kinote:content[^>]*>$/.test(l) && l !== '</kinote:content>')
    .join('\n');
}
