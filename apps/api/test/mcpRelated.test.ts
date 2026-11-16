import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { documents, entities, entityEdges, entityMentions, links, withTenantTx } from '@kinote/db';
import { EMBEDDING_DIMENSIONS, defaultEmbeddingProvider, entityRelations } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, publishPage, unwrap, type AgentWorld } from './support/mcpkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);
const unit = () => {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = 1;
  return v;
};

describe('kinote_related', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
  });

  const related = async (w: AgentWorld, args: object) => {
    const res = await callTool(app, w.token, 'kinote_related', args);
    return { ...res, text: unwrap(res.text) };
  };

  /**
   * Payments (system) is mentioned on Billing and Refunds (Open) and on Vault (Hidden). Team Atlas owns Payments
   * (an edge recorded on Billing); Payments depends on Ledger (an edge recorded on Vault, Ledger mentioned only there).
   * Wiki home links to Billing.
   */
  async function graph(slug: string) {
    const w = await agentWorld(app, slug);
    const billing = await publishPage(app, w.ownerHeaders, w.open.id, 'Billing', 'Billing runs on Payments.');
    const refunds = await publishPage(app, w.ownerHeaders, w.open.id, 'Refunds', 'Refunds go through Payments.');
    const home = await publishPage(app, w.ownerHeaders, w.open.id, 'Wiki home', 'Start here.');
    const vault = await publishPage(app, w.ownerHeaders, w.hidden.id, 'Vault', 'Payments depends on Ledger.');
    await runPendingJobsForTenant(w.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    const ids = await withTenantTx(w.tenant.id, async (tx) => {
      const docs = await tx.select().from(documents).where(eq(documents.tenantId, w.tenant.id));
      const version = (id: string) => docs.find((d) => d.id === id)!.latestVersionId!;
      const space = (id: string) => docs.find((d) => d.id === id)!.spaceId;
      // Start clean: whatever the deterministic placement model extracted is not part of this fixture.
      await tx.delete(entityEdges).where(eq(entityEdges.tenantId, w.tenant.id));
      await tx.delete(entityMentions).where(eq(entityMentions.tenantId, w.tenant.id));
      const mk = async (name: string, kind: 'system' | 'team') =>
        (
          await tx
            .insert(entities)
            .values({ tenantId: w.tenant.id, kind, name, normalizedName: name.toLowerCase(), nameEmbedding: unit() })
            .onConflictDoUpdate({ target: [entities.tenantId, entities.kind, entities.normalizedName], set: { name } })
            .returning()
        )[0]!.id;
      const payments = await mk('Payments', 'system');
      const atlas = await mk('Team Atlas', 'team');
      const ledger = await mk('Ledger', 'system');
      const mention = (entityId: string, docId: string, surface: string) =>
        tx.insert(entityMentions).values({
          tenantId: w.tenant.id,
          entityId,
          documentId: docId,
          versionId: version(docId),
          spaceId: space(docId),
          blockIds: [],
          surfaces: [surface],
          surfaceKeys: [surface.toLowerCase()],
        });
      await mention(payments, billing, 'Payments');
      await mention(payments, refunds, 'Payments');
      await mention(payments, vault, 'Payments');
      await mention(atlas, billing, 'Team Atlas');
      await mention(ledger, vault, 'Ledger');
      const edge = (from: string, to: string, type: 'owns' | 'depends_on', docId: string) =>
        tx.insert(entityEdges).values({
          tenantId: w.tenant.id,
          fromEntityId: from,
          toEntityId: to,
          type,
          documentId: docId,
          versionId: version(docId),
          spaceId: space(docId),
        } as typeof entityEdges.$inferInsert);
      await edge(atlas, payments, 'owns', billing);
      await edge(payments, ledger, 'depends_on', vault);
      await tx.insert(links).values({ tenantId: w.tenant.id, fromPageId: home, fromBlockId: 'b1', toDocumentId: billing } as typeof links.$inferInsert);
      return { payments, atlas, ledger };
    });
    return { w, billing, refunds, home, vault, ...ids };
  }

  test('an entity lookup prints the relationship and the pages that mention it', async () => {
    const g = await graph('rel-entity');
    const res = await related(g.w, { entity: 'payments' });
    assert.equal(res.isError, false, res.text);
    const lines = res.text.split('\n');
    assert.equal(lines[0], 'Payments (system)');
    assert.ok(lines.includes('Relationships:'));
    assert.ok(lines.includes('- Team Atlas owns Payments'));
    assert.ok(lines.includes('Mentioned on:'));
    assert.ok(lines.includes(`- Billing (${short(g.billing)})`));
    assert.ok(lines.includes(`- Refunds (${short(g.refunds)})`));
    assert.ok(!res.text.includes('Vault'));
    assert.ok(!res.text.includes('is about'));
  });

  test('an edge recorded on a page in an ungranted space is not shown', async () => {
    const g = await graph('rel-hidden');
    const res = await related(g.w, { entity: 'Payments' });
    assert.ok(!res.text.includes('depends on'));
    assert.ok(!res.text.includes('Ledger'));
    const ledger = await related(g.w, { entity: 'Ledger' });
    assert.equal(ledger.text, 'No "Ledger" found in the spaces this agent can read. Try kinote_search.');
  });

  test('hops 2 reaches pages through a relationship, saying via what', async () => {
    const g = await graph('rel-hops');
    const res = await related(g.w, { entity: 'Team Atlas', hops: 2 });
    assert.ok(res.text.includes('- Team Atlas owns Payments'));
    assert.ok(res.text.split('\n').includes(`- Refunds (${short(g.refunds)}), via Payments`), res.text);
  });

  test('a page lookup shows links in and pages that share entities', async () => {
    const g = await graph('rel-page');
    const res = await related(g.w, { page_id: short(g.billing) });
    assert.equal(res.isError, false, res.text);
    const lines = res.text.split('\n');
    assert.equal(lines[0], `# Billing (${short(g.billing)})`);
    assert.ok(lines.includes('Links in:'));
    assert.ok(lines.includes(`- Wiki home (${short(g.home)}) · Open`));
    assert.ok(lines.includes('Shares entities:'));
    assert.ok(lines.includes(`- Refunds (${short(g.refunds)}) — Payments`));
    assert.ok(!res.text.includes('Vault'));
    assert.ok(!res.text.includes('Updated by captures:'));
  });

  test('a page with no connections says so', async () => {
    const g = await graph('rel-none');
    const lonely = await publishPage(app, g.w.ownerHeaders, g.w.open.id, 'Lonely', 'Nobody links here.');
    assert.equal((await related(g.w, { page_id: lonely })).text, 'Nothing connects to this page yet.');
  });

  test('both or neither argument gives the error text', async () => {
    const g = await graph('rel-args');
    for (const args of [{ page_id: g.billing, entity: 'Payments' }, {}]) {
      const res = await related(g.w, args);
      assert.equal(res.isError, true);
      assert.equal(res.text, 'Give page_id or entity, not both.');
    }
  });

  test('entityRelations keeps to the filter spaces and names the other side by a readable spelling', async () => {
    const g = await graph('rel-core');
    const rels = await withTenantTx(g.w.tenant.id, (tx) =>
      entityRelations(tx, { tenantId: g.w.tenant.id, spaceIds: [g.w.open.id] }, g.payments)
    );
    assert.deepEqual(rels, [{ type: 'owns', direction: 'in', otherEntityId: g.atlas, otherName: 'Team Atlas', documentId: g.billing }]);
  });
});
