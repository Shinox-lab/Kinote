import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blockActivity, citations, suggestions, withTenantTx } from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import { planCapture, type FactPlan, type RoutingModel } from '../src/index.js';
import {
  addCapture,
  addMember,
  addRoutingSpace,
  embedder,
  liveBlockId,
  livePage,
  model,
  routingWorld,
} from './fixtures/routingSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

async function planned(tenantId: string, captureId: string, m: RoutingModel = model) {
  return planCapture({ tenantId, captureId }, { model: m, embedder });
}

function only(plans: Array<{ plan: FactPlan }>): FactPlan {
  expect(plans).toHaveLength(1);
  return plans[0]!.plan;
}

async function billingWorld() {
  const w = await routingWorld();
  const eng = await addRoutingSpace(w, { name: 'Engineering' });
  const billing = await livePage(w, eng, 'Billing service', 'Billing uses Stripe.\n\nInvoices go out monthly.');
  return { w, eng, billing };
}

describe('planCapture', () => {
  it('a change lands on the page that already states it', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing moved to Adyen.')));
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({
      edit: { op: { op: 'replace', documentId: billing.documentId, blockId: block } },
      gate: null,
      beforeMarkdown: 'Billing uses Stripe.',
    });
  });

  it('a removal is gated', async () => {
    const { w } = await billingWorld();
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing no longer uses Stripe.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => [e.edit.op.op, e.gate])).toEqual([['remove', 'removal']]);
  });

  it('a block a person edited a minute ago is gated as protection', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    await withTenantTx(w.tenantId, (tx) =>
      tx.insert(blockActivity).values({
        tenantId: w.tenantId, pageId: billing.documentId, blockId: block, actorType: 'user', actorId: w.userId,
        changedAt: new Date(Date.now() - 60_000),
      })
    );
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing moved to Adyen.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => e.gate)).toEqual(['protection']);
  });

  it('a block citing a valid version is gated as conflict', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    const [cite] = await withTenantTx(w.tenantId, (tx) =>
      tx
        .insert(citations)
        .values({
          tenantId: w.tenantId, pageId: billing.documentId, blockId: block, sourceKind: 'version',
          sourceDocumentId: billing.documentId, sourceVersionId: billing.versionId, quote: 'Stripe',
          createdByType: 'user', createdBy: w.userId,
        })
        .returning()
    );
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing moved to Adyen.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => [e.gate, e.conflictCitationId])).toEqual([['conflict', cite!.id]]);
  });

  it('a page in a read-only space is gated as no_edit_access', async () => {
    const { w, eng } = await billingWorld();
    const own = await addRoutingSpace(w, { name: 'Mine' });
    const sender = await addMember(w, [[eng, 'viewer'], [own, 'editor']]);
    const plan = only(await planned(w.tenantId, await addCapture(w, sender, 'Billing moved to Adyen.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => e.gate)).toEqual(['no_edit_access']);
  });

  it('a fact the page already states is already_known', async () => {
    const { w, billing } = await billingWorld();
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing uses Stripe.')));
    expect(plan).toMatchObject({ status: 'already_known', documentId: billing.documentId });
  });

  it('an operation matching an open suggestion is dropped', async () => {
    const { w, eng, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Billing uses Stripe');
    await withTenantTx(w.tenantId, (tx) =>
      tx.insert(suggestions).values({
        tenantId: w.tenantId, documentId: billing.documentId, spaceId: eng, blockId: block, kind: 'remove',
        reason: 'Earlier capture', blockedBy: 'removal',
      })
    );
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing no longer uses Stripe.')));
    expect(plan).toMatchObject({ status: 'already_known', documentId: billing.documentId });
  });

  it('two close candidates send the fact to needs_home', async () => {
    const { w, eng, billing } = await billingWorld();
    const other = await livePage(w, eng, 'Payments', 'Payments are handled by Billing.');
    const torn: RoutingModel = Object.assign(Object.create(model), {
      async planEdits() {
        return {
          edits: [
            { op: { op: 'insert_after', documentId: billing.documentId, after: null, markdown: 'x' }, confidence: 0.8, reason: 'a' },
            { op: { op: 'insert_after', documentId: other.documentId, after: null, markdown: 'x' }, confidence: 0.75, reason: 'b' },
          ],
        };
      },
    });
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing has a new owner.'), torn));
    expect(plan.status).toBe('needs_home');
  });

  it('an ambiguous name asks a question', async () => {
    const w = await routingWorld();
    const eng = await addRoutingSpace(w);
    await livePage(w, eng, 'Team', 'Aisha Rahman leads Payments.');
    await livePage(w, eng, 'People', 'Aisha Tan leads Search.');
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Aisha owns Billing.')));
    expect(plan.status).toBe('question');
    if (plan.status !== 'question') return;
    expect(plan.names).toEqual(['Aisha']);
    expect(plan.options.map((o) => o.label).sort()).toEqual(['Aisha Rahman', 'Aisha Tan']);
  });

  it('an answered question pins the entity and plans', async () => {
    const w = await routingWorld();
    const eng = await addRoutingSpace(w);
    const team = await livePage(w, eng, 'Team', 'Aisha Rahman leads Payments.');
    await livePage(w, eng, 'People', 'Aisha Tan leads Search.');
    const captureId = await addCapture(w, w.userId, 'Aisha is on leave.');
    const first = only(await planned(w.tenantId, captureId));
    if (first.status !== 'question') throw new Error('expected a question');
    const rahman = first.options.find((o) => o.label === 'Aisha Rahman')!.entityId;
    const plans = await planCapture(
      { tenantId: w.tenantId, captureId },
      { model, embedder, facts: [{ ordinal: 0, factId: null, fact: { statement: 'Aisha is on leave.', kind: 'new', names: ['Aisha'], date: null }, pinnedEntityIds: [rahman] }] }
    );
    const plan = only(plans);
    expect(plan.status === 'planned' && plan.edits[0]!.edit.op).toMatchObject({ documentId: team.documentId });
  });

  it('Inbox pages are never candidates', async () => {
    const w = await routingWorld();
    const inbox = await addRoutingSpace(w, { kind: 'inbox' });
    await addRoutingSpace(w);
    await livePage(w, inbox, 'Private', 'Billing uses Stripe.');
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing moved to Adyen.')));
    expect(plan.status).toBe('needs_home');
  });

  it('a scope limits candidates to that space', async () => {
    const { w } = await billingWorld();
    const clients = await addRoutingSpace(w, { name: 'Clients' });
    const acme = await livePage(w, clients, 'Acme billing', 'Billing uses Stripe for Acme.');
    const plan = only(
      await planned(w.tenantId, await addCapture(w, w.userId, 'Billing moved to Adyen.', { spaceId: clients }))
    );
    expect(plan.status === 'planned' && plan.edits.map((e) => (e.edit.op as { documentId: string }).documentId)).toEqual([
      acme.documentId,
    ]);
  });
});
