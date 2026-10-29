import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { createServerEditor } from '@kinote/shared';
import { blockActivity, captureFacts, captureMessages, citations, pages, suggestions, withTenantTx } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import { planCapture, type FactPlan, type PlanEditsInput, type PlannedEdit, type RoutingModel } from '../src/index.js';
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

  it('the engine never replaces or removes a drawing block', async () => {
    const { w, billing } = await billingWorld();
    const doc = createServerEditor().blocksToYDoc(
      [
        { id: 'p1', type: 'paragraph', content: 'Billing uses Stripe.', children: [] },
        { id: 'd1', type: 'drawing', props: { drawingId: 'g1', title: 'Billing flow' }, children: [] },
      ] as any,
      'document-store'
    );
    await withTenantTx(w.tenantId, (tx) =>
      tx.update(pages).set({ ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)) }).where(eq(pages.documentId, billing.documentId))
    );
    const edits: PlannedEdit[] = [
      { op: { op: 'replace', documentId: billing.documentId, blockId: 'd1', markdown: 'Billing flow v2' }, confidence: 0.9, reason: 'r' },
      { op: { op: 'remove', documentId: billing.documentId, blockId: 'd1' }, confidence: 0.9, reason: 'r' },
      { op: { op: 'insert_after', documentId: billing.documentId, after: 'd1', markdown: 'Refunds go through Stripe too.' }, confidence: 0.9, reason: 'r' },
    ];
    const drawingModel: RoutingModel = Object.assign(Object.create(model), { async planEdits() { return { edits }; } });
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Refunds go through Stripe too.', { pageId: billing.documentId }), drawingModel));
    expect(plan.status === 'planned' && plan.edits.map((e) => e.edit.op.op)).toEqual(['insert_after']);
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

  it('an insert of text the page already holds is already_known, whatever the model says', async () => {
    const { w, billing } = await billingWorld();
    const block = await liveBlockId(w, billing.documentId, 'Invoices go out monthly');
    const repeating: RoutingModel = Object.assign(Object.create(model), {
      async planEdits() {
        return {
          edits: [
            {
              op: { op: 'insert_after', documentId: billing.documentId, after: null, markdown: 'Invoices go out  monthly' },
              confidence: 0.9,
              reason: 'x',
            },
          ],
        };
      },
    });
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Invoices are monthly.'), repeating));
    expect(plan).toMatchObject({ status: 'already_known', documentId: billing.documentId, blockId: block });
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

  it('a re-run plans neither facts waiting on a question nor facts a person placed', async () => {
    const { w } = await billingWorld();
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen. Aisha owns Atlas. Lunch is at noon.');
    await withTenantTx(w.tenantId, async (tx) => {
      const [q] = await tx
        .insert(captureMessages)
        .values({ tenantId: w.tenantId, captureId, author: 'engine', body: 'Which Atlas?', options: [] })
        .returning();
      await tx.insert(captureFacts).values([
        { tenantId: w.tenantId, captureId, ordinal: 0, statement: 'Billing moved to Adyen.', kind: 'change', names: ['Billing'] },
        { tenantId: w.tenantId, captureId, ordinal: 1, statement: 'Aisha owns Atlas.', kind: 'new', names: ['Atlas'], waitingQuestionId: q!.id },
        { tenantId: w.tenantId, captureId, ordinal: 2, statement: 'Lunch is at noon.', kind: 'new', placedBy: w.userId },
      ]);
    });
    const plans = await planned(w.tenantId, captureId);
    expect(plans.map((p) => p.ordinal)).toEqual([0]);
  });

  it('a long capture is split part by part, so no part loses its facts', async () => {
    const { w } = await billingWorld();
    const texts: string[] = [];
    const counting: RoutingModel = Object.assign(Object.create(model), {
      async splitCapture(input: { text: string }) {
        texts.push(input.text);
        return model.splitCapture(input);
      },
    });
    const para = (n: number) => `Paragraph ${n} says ${'something '.repeat(240).trim()}.`;
    const text = [para(1), para(2), para(3)].join('\n\n');
    const plans = await planned(w.tenantId, await addCapture(w, w.userId, text), counting);
    expect(texts.length).toBe(3);
    expect(texts.join('\n\n')).toBe(text);
    expect(plans.map((p) => p.ordinal)).toEqual([0, 1, 2]);
  });

  it('a capture the model splits into nothing goes to needs_home whole', async () => {
    const { w } = await billingWorld();
    const empty: RoutingModel = Object.assign(Object.create(model), {
      async splitCapture() {
        return { facts: [] };
      },
    });
    const plans = await planned(w.tenantId, await addCapture(w, w.userId, 'Something the model could not read.'), empty);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.fact.statement).toBe('Something the model could not read.');
    expect(plans[0]!.plan.status).toBe('needs_home');
  });

  it('a block far down a long page is shown to the planner', async () => {
    const w = await routingWorld();
    const eng = await addRoutingSpace(w);
    const filler = Array.from({ length: 50 }, (_, i) => `Filler line ${i + 1}.`);
    filler.splice(45, 0, 'Billing uses Stripe.');
    const page = await livePage(w, eng, 'Long page', filler.join('\n\n'));
    const block = await liveBlockId(w, page.documentId, 'Billing uses Stripe');
    const plan = only(await planned(w.tenantId, await addCapture(w, w.userId, 'Billing moved to Adyen.')));
    expect(plan.status === 'planned' && plan.edits[0]!.edit.op).toMatchObject({ op: 'replace', blockId: block });
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

describe('page tree', () => {
  it("the planner sees each candidate's path, siblings and children", async () => {
    const w = await routingWorld();
    const clients = await addRoutingSpace(w, { name: 'Clients' });
    const george = await livePage(w, clients, 'Client - George', 'George is a client.');
    await livePage(w, clients, 'Meeting 1', 'Meeting one agenda.', { parentId: george.documentId });
    const sep = await livePage(w, clients, '29Sep', 'George hero video notes.', { parentId: george.documentId });
    const seen: PlanEditsInput[] = [];
    const recording: RoutingModel = Object.assign(Object.create(model), {
      async planEdits(input: PlanEditsInput) {
        seen.push(input);
        return model.planEdits(input);
      },
    });
    await planned(w.tenantId, await addCapture(w, w.userId, 'George hero video moved to Friday.'), recording);
    const byId = new Map(seen[0]!.candidates.map((c) => [c.documentId, c]));
    expect(byId.get(sep.documentId)).toMatchObject({ path: ['Client - George'], siblings: ['Meeting 1'], children: [], parentId: george.documentId });
    expect(byId.get(george.documentId)).toMatchObject({ path: [], siblings: [], children: ['29Sep', 'Meeting 1'] });
  });
});
