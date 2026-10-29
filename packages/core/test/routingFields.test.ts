import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blockActivity, suggestions, withTenantTx } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import { canonicalFieldJson } from '@kinote/contracts';
import { planCapture, type FactPlan, type PlanEditsInput, type PlannedEdit, type RoutingModel } from '../src/index.js';
import { addCapture, addCollection, addMember, addRoutingSpace, embedder, livePage, model, routingWorld, setLiveFields } from './fixtures/routingSeed.js';

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

/** Space "Clients"; page "Clients" is a collection; row "George" has Status = Lead and Launch date = 2026-11-15. */
async function clientsWorld(opts: { reviewRequired?: boolean } = {}) {
  const w = await routingWorld();
  const space = await addRoutingSpace(w, { name: 'Clients', reviewRequired: opts.reviewRequired });
  const clients = await livePage(w, space, 'Clients', 'Our clients.');
  const [status, launch, owner] = await addCollection(w, clients.documentId, [
    { name: 'Status', type: 'select', choices: ['Lead', 'Active', 'Churned'] },
    { name: 'Launch date', type: 'date' },
    { name: 'Owner', type: 'person' },
  ]);
  const george = await livePage(w, space, 'George', 'George is a retail client.', { parentId: clients.documentId });
  await setLiveFields(w, george.documentId, { [status!.id]: 'status:lead', [launch!.id]: { start: '2026-11-15' } });
  return { w, space, clients, george, status: status!, launch: launch!, owner: owner! };
}

const fixed = (edits: PlannedEdit[]): RoutingModel => Object.assign(Object.create(model), { async planEdits() { return { edits }; } });

describe('planning field changes', () => {
  it('a change to a row field plans set_field with the resolved value', async () => {
    const c = await clientsWorld();
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-12-01.')));
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({
      edit: { op: { op: 'set_field', documentId: c.george.documentId, fieldId: c.launch.id, value: { start: '2026-12-01' } } },
      gate: null,
      beforeMarkdown: canonicalFieldJson({ start: '2026-11-15' }),
      expectedText: canonicalFieldJson({ start: '2026-11-15' }),
    });
  });

  it('a select value is planned by choice id', async () => {
    const c = await clientsWorld();
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George status is now Active.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => e.edit.op)).toEqual([
      { op: 'set_field', documentId: c.george.documentId, fieldId: c.status.id, value: 'status:active' },
    ]);
  });

  it('an unknown choice drops the edit', async () => {
    const c = await clientsWorld();
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George status is now Paused.')));
    expect(plan.status === 'planned' ? plan.edits.filter((e) => e.edit.op.op === 'set_field') : []).toEqual([]);
  });

  it('clearing a field that has a value is gated as a removal', async () => {
    const c = await clientsWorld();
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George no longer has a launch date.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => [e.edit.op, e.gate])).toEqual([
      [{ op: 'set_field', documentId: c.george.documentId, fieldId: c.launch.id, value: null }, 'removal'],
    ]);
  });

  it('a value equal to the live one is already_known', async () => {
    const c = await clientsWorld();
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-11-15.')));
    expect(plan).toEqual({ status: 'already_known', documentId: c.george.documentId, blockId: `field:${c.launch.id}` });
  });

  it('a field a person changed a minute ago is gated as protection', async () => {
    const c = await clientsWorld();
    await withTenantTx(c.w.tenantId, (tx) =>
      tx.insert(blockActivity).values({
        tenantId: c.w.tenantId, pageId: c.george.documentId, blockId: `field:${c.launch.id}`, actorType: 'user', actorId: c.w.userId,
        changedAt: new Date(Date.now() - 60_000),
      })
    );
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-12-01.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => e.gate)).toEqual(['protection']);
  });

  it('a row in a read-only space is gated as no_edit_access', async () => {
    const c = await clientsWorld();
    const own = await addRoutingSpace(c.w, { name: 'Mine' });
    const sender = await addMember(c.w, [[c.space, 'viewer'], [own, 'editor']]);
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, sender, 'George launch date moved to 2026-12-01.')));
    expect(plan.status === 'planned' && plan.edits.map((e) => [e.edit.op.op, e.gate])).toEqual([['set_field', 'no_edit_access']]);
  });

  it('a set_field matching an open set_field suggestion is dropped', async () => {
    const c = await clientsWorld();
    await withTenantTx(c.w.tenantId, (tx) =>
      tx.insert(suggestions).values({
        tenantId: c.w.tenantId, documentId: c.george.documentId, spaceId: c.space, blockId: `field:${c.launch.id}`, kind: 'set_field',
        proposedMarkdown: canonicalFieldJson({ start: '2026-12-01' }), expectedText: canonicalFieldJson({ start: '2026-11-15' }),
        reason: 'Earlier capture', blockedBy: 'protection',
      })
    );
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-12-01.')));
    expect(plan).toEqual({ status: 'already_known', documentId: c.george.documentId, blockId: `field:${c.launch.id}` });
  });

  it('the planner is shown the row fields, choices and live values', async () => {
    const c = await clientsWorld();
    let seen: PlanEditsInput | null = null;
    const recording: RoutingModel = Object.assign(Object.create(model), {
      async planEdits(input: PlanEditsInput) {
        seen = input;
        return model.planEdits(input);
      },
    });
    await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'George launch date moved to 2026-12-01.'), recording);
    const george = seen!.candidates.find((x) => x.documentId === c.george.documentId)!;
    expect(george.fields).toEqual([
      { id: c.status.id, name: 'Status', type: 'select', choices: ['Lead', 'Active', 'Churned'] },
      { id: c.launch.id, name: 'Launch date', type: 'date', choices: [] },
      { id: c.owner.id, name: 'Owner', type: 'person', choices: [] },
    ]);
    expect(george.values[c.launch.id]).toBe('2026-11-15 (15 November 2026)');
    expect(george.values[c.status.id]).toBe('Lead');
    expect(george.fieldsOnly).toBe(false);
    const clients = seen!.candidates.find((x) => x.documentId === c.clients.documentId);
    if (clients) expect(clients.collectionFields?.map((f) => f.name)).toEqual(['Status', 'Launch date', 'Owner']);
  });

  it('a create_page under a collection keeps only fields that resolve', async () => {
    const c = await clientsWorld();
    const creating = fixed([
      {
        op: {
          op: 'create_page',
          spaceId: c.space,
          parentId: c.clients.documentId,
          title: 'Hana',
          markdown: 'Hana is a new client.',
          fields: [
            { fieldId: c.status.id, value: 'Active' },
            { fieldId: c.status.id, value: 'Paused' },
          ],
        },
        confidence: 0.9,
        reason: 'A new client.',
      },
    ]);
    const plan = only(await planned(c.w.tenantId, await addCapture(c.w, c.w.userId, 'Hana is a new client.'), creating));
    expect(plan.status === 'planned' && plan.edits.map((e) => e.edit.op)).toEqual([
      expect.objectContaining({ op: 'create_page', fields: [{ fieldId: c.status.id, value: 'status:active' }] }),
    ]);
  });
});
