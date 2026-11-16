import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { captureChanges, captureFacts, captures, documents, withTenantTx } from '@kinote/db';
import { DeterministicPlacementModel, previewOf, type Actor, type SplitCaptureInput, type PlanEditsInput } from '@kinote/core';
import type { BlockLike } from '@kinote/shared';
import { readBlocks } from '../../collab/test/support/blocks.js';
import { storedDoc } from '../../collab/test/support/collabWorld.js';
import { createCapture } from '../src/routes/captures.js';
import { applyCapturePreview, cancelCapturePreview } from '../src/routes/capturePreview.js';
import { useCaptureKit, type CaptureWorld } from './support/capturekit.js';

/** Counts the model calls routing makes, so a test can tell an applied preview never plans again. */
class CountingModel extends DeterministicPlacementModel {
  splits = 0;
  plans = 0;
  override async splitCapture(input: SplitCaptureInput) {
    this.splits += 1;
    return super.splitCapture(input);
  }
  override async planEdits(input: PlanEditsInput) {
    this.plans += 1;
    return super.planEdits(input);
  }
}

describe('capture previews', () => {
  const model = new CountingModel();
  const k = useCaptureKit({ model });

  const ownerActor = (w: CaptureWorld): Actor => ({ tenantId: w.tenant.id, principalType: 'user', principalId: w.owner.userId, tenantRole: 'owner' });
  const row = async (tenantId: string, id: string) =>
    (await withTenantTx(tenantId, (tx) => tx.select().from(captures).where(eq(captures.id, id))))[0]!;
  const factsOf = (tenantId: string, id: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(captureFacts).where(eq(captureFacts.captureId, id)).orderBy(captureFacts.ordinal));
  async function preview(w: CaptureWorld, text: string) {
    const made = await createCapture(ownerActor(w), { text }, { preview: true });
    await w.run();
    return made.id;
  }

  test('a preview plans and changes nothing', async () => {
    const w = await k.world();
    const id = await preview(w, 'George launch moved to December.');
    const r = await row(w.tenant.id, id);
    expect(r.status).toBe('previewed');
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
    const plan = previewOf(r)!;
    expect(plan.facts[0]!.plan.status).toBe('planned');
    const edits = plan.facts[0]!.plan.status === 'planned' ? plan.facts[0]!.plan.edits : [];
    expect(edits.map((e) => ('documentId' in e.edit.op ? e.edit.op.documentId : null))).toContain(w.george);
    expect(await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.captureId, id)))).toEqual([]);
  });

  test('apply files exactly the stored plan, with no model call', async () => {
    const w = await k.world();
    const id = await preview(w, 'George launch moved to December.');
    const before = { splits: model.splits, plans: model.plans };
    const detail = await applyCapturePreview(ownerActor(w), id, {});
    expect(detail.capture).toMatchObject({ status: 'queued', preview: false });
    await w.run();
    expect(await k.pageText(w.tenant.id, w.george)).toContain('December');
    expect({ splits: model.splits, plans: model.plans }).toEqual(before);
    expect((await row(w.tenant.id, id)).status).toBe('done');
  });

  test('apply after the block changed suggests instead', async () => {
    const w = await k.world();
    const id = await preview(w, 'George launch moved to December.');
    const plan = previewOf(await row(w.tenant.id, id))!;
    const edit = plan.facts[0]!.plan.status === 'planned' ? plan.facts[0]!.plan.edits[0]! : null;
    expect(edit?.edit.op.op).toBe('replace');
    const [block] = readBlocks(await storedDoc(w.tenant.id, w.george)) as BlockLike[];
    await k.collab.applyBlockOps({
      tenantId: w.tenant.id,
      pageId: w.george,
      actor: { type: 'user', id: w.owner.userId },
      source: 'human',
      ops: [
        {
          op: 'replace',
          blockId: block!.id,
          blocks: [{ id: 'x', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'George is a client. Launch is in January.', styles: {} }], children: [] }],
        },
      ],
    });
    await applyCapturePreview(ownerActor(w), id, {});
    await w.run();
    expect((await factsOf(w.tenant.id, id)).map((f) => f.outcome)).toEqual(['suggested']);
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in January.');
  });

  test('skip one fact and place another', async () => {
    const w = await k.world();
    const id = await preview(w, 'George launch moved to December. George hero video is final.');
    const [first, second] = await factsOf(w.tenant.id, id);
    await applyCapturePreview(ownerActor(w), id, { skip: [first!.id], place: [{ fact_id: second!.id, document_id: w.sep29 }] });
    await w.run();
    const [a, b] = await factsOf(w.tenant.id, id);
    expect(a!.outcome).toBe('dismissed');
    expect(b!.outcome).toBe('applied');
    expect(await k.pageText(w.tenant.id, w.sep29)).toContain('hero video is final');
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
  });

  test('cancel drops it; a second cancel or an apply is 409', async () => {
    const w = await k.world();
    const id = await preview(w, 'George launch moved to December.');
    const detail = await cancelCapturePreview(ownerActor(w), id);
    expect(detail.capture.status).toBe('cancelled');
    expect((await factsOf(w.tenant.id, id)).map((f) => f.outcome)).toEqual(['dismissed']);
    await expect(cancelCapturePreview(ownerActor(w), id)).rejects.toMatchObject({ code: 'capture_not_previewed' });
    await expect(applyCapturePreview(ownerActor(w), id, {})).rejects.toMatchObject({ code: 'capture_not_previewed' });
    await w.run();
    expect(await k.pageText(w.tenant.id, w.george)).toBe('George is a client. Launch is in November.');
  });

  test('a document preview makes no page until applied', async () => {
    const w = await k.world();
    const pagesBefore = (await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents))).length;
    const id = await preview(w, 'George kickoff\n- Hero video is final.\n- Shop the look.\n- Launch in December.');
    expect((await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents))).length).toBe(pagesBefore);
    const plan = previewOf(await row(w.tenant.id, id))!;
    expect(plan.document?.status).toBe('place');
    const parentId = plan.document?.status === 'place' ? plan.document.parentId : null;
    await applyCapturePreview(ownerActor(w), id, {});
    await w.run();
    const r = await row(w.tenant.id, id);
    expect(r.documentOutcome).toBe('created');
    const [page] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(documents).where(eq(documents.id, r.documentPageId!)));
    expect(page!.parentId).toBe(parentId);
  });
});
