import { describe, expect, it } from 'vitest';
import { captureFacts, withTenantTx } from '@living-wiki/db';
import { planCapture, recordRoutingExample, type PlanEditsInput, type RoutingModel } from '@living-wiki/core';
import { useTestDb } from '../../api/test/support/testkit.js';
import {
  addCapture,
  addRoutingSpace,
  embedder,
  livePage,
  model,
  routingWorld,
} from '../../../packages/core/test/fixtures/routingSeed.js';

describe('routing examples', () => {
  useTestDb();

  it("the planner is shown the space's routing examples", async () => {
    const w = await routingWorld();
    const eng = await addRoutingSpace(w, { name: 'Engineering' });
    const elsewhere = await addRoutingSpace(w, { name: 'Elsewhere' });
    const billing = await livePage(w, eng, 'Billing service', 'Billing uses Stripe.');
    const far = await livePage(w, elsewhere, 'Far away', 'Nothing about money.');
    await recordRoutingExample(
      w.tenantId,
      { statement: 'Billing invoices are sent by email.', chosenDocumentId: billing.documentId, wrongDocumentId: null, createdBy: w.userId },
      embedder
    );
    await recordRoutingExample(
      w.tenantId,
      { statement: 'Billing is unrelated here.', chosenDocumentId: far.documentId, wrongDocumentId: null, createdBy: w.userId },
      embedder
    );

    const seen: PlanEditsInput[] = [];
    const recording: RoutingModel = Object.assign(Object.create(model), {
      async planEdits(input: PlanEditsInput) {
        seen.push(input);
        return model.planEdits(input);
      },
    });
    const captureId = await addCapture(w, w.userId, 'Billing moved to Adyen.', { spaceId: eng });
    await planCapture({ tenantId: w.tenantId, captureId }, { model: recording, embedder });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.examples).toEqual([{ statement: 'Billing invoices are sent by email.', chosenTitle: 'Billing service' }]);
    expect(await withTenantTx(w.tenantId, (tx) => tx.select().from(captureFacts))).toEqual([]);
  });
});
