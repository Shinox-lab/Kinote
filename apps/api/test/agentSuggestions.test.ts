import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { agents, auditEvents, suggestions, versions, withTenantTx } from '@kinote/db';
import { blockText, ensureRouterAgent } from '@kinote/core';
import { blockFullText, type BlockLike } from '@kinote/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, createAgent, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/** Suggestions an agent proposed (kinote_edit): named on the card, applied as the agent, never decided by its owner. */
describe('suggestions proposed by agents', () => {
  let server: CollabServer;
  let app: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    app = buildTestApp({ collab: new InProcessCollabClient(server) });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const post = (headers: Headers, url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers, payload: payload as never });

  async function world(review = false) {
    const { tenant, owner, headers } = await bootstrapTenant(app, { name: 'Agent Suggest Co', slug: 'agent-suggest-co' });
    const spaceId = (await post(headers, '/api/v1/spaces', { name: 'docs', slug: 'docs', review_required: review })).json().id as string;
    const pageId = (
      await post(headers, '/api/v1/pages', { space_id: spaceId, title: 'billing', slug: 'billing', markdown: 'Billing uses Stripe.\n\nInvoices go out monthly.' })
    ).json().id as string;
    const member = await signUpMember(app, tenant.id, 'member');
    await post(headers, `/api/v1/spaces/${spaceId}/grants`, { principal_type: 'user', principal_id: member.userId, role: review ? 'reviewer' : 'editor' });
    const agentId = await createAgent(tenant.id, member.userId, { name: 'Docs bot' });
    const blocks = readBlocks(await storedDoc(tenant.id, pageId)) as BlockLike[];
    const block = blocks.find((b) => blockText(b).includes('Stripe'))!;
    const [row] = await withTenantTx(tenant.id, (tx) =>
      tx
        .insert(suggestions)
        .values({
          tenantId: tenant.id,
          documentId: pageId,
          spaceId,
          blockId: block.id,
          kind: 'remove',
          reason: 'Stripe was replaced.',
          blockedBy: 'removal',
          expectedText: blockFullText(block),
          proposedByType: 'agent',
          proposedBy: agentId,
        })
        .returning()
    );
    return { tenant, owner, headers, spaceId, pageId, member, agentId, suggestionId: row!.id };
  }

  const latestVersion = async (tenantId: string, pageId: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(versions).where(eq(versions.documentId, pageId)).orderBy(desc(versions.number))))[0]!;

  test('the list names the proposing agent', async () => {
    const w = await world();
    const res = await app.inject({ method: 'GET', url: `/api/v1/pages/${w.pageId}/suggestions`, headers: w.headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()[0].proposedBy).toEqual({ type: 'agent', id: w.agentId, name: 'Docs bot' });
  });

  test("accepting an agent's suggestion applies it as that agent", async () => {
    const w = await world();
    const res = await post(w.headers, `/api/v1/suggestions/${w.suggestionId}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().proposedBy).toMatchObject({ type: 'agent', id: w.agentId });
    const v = await latestVersion(w.tenant.id, w.pageId);
    expect({ type: v.createdByType, id: v.createdBy }).toEqual({ type: 'agent', id: w.agentId });
    const [audit] = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, w.tenant.id), eq(auditEvents.type, 'suggestion.accepted')))
    );
    expect(audit!.actorId).toBe(w.owner.userId);
  });

  test("a disabled agent's suggestion is accepted as the Routing engine", async () => {
    const w = await world();
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ disabledAt: new Date() }).where(eq(agents.id, w.agentId)));
    const res = await post(w.headers, `/api/v1/suggestions/${w.suggestionId}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    const routerId = await withTenantTx(w.tenant.id, (tx) => ensureRouterAgent(tx, w.tenant.id));
    expect((await latestVersion(w.tenant.id, w.pageId)).createdBy).toBe(routerId);
  });

  test("the agent's owner cannot decide it in a review space", async () => {
    const w = await world(true);
    const own = await post(w.member.headers, `/api/v1/suggestions/${w.suggestionId}/accept`);
    expect(own.statusCode).toBe(409);
    expect(own.json().error).toBe('self_approval');
    const other = await post(w.headers, `/api/v1/suggestions/${w.suggestionId}/accept`);
    expect(other.statusCode, other.body).toBe(200);
  });
});
