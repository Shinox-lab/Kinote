import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../src/testing.js';
import {
  acquireRoutingLease,
  agents,
  captureChanges,
  captureFacts,
  captures,
  citations,
  documents,
  releaseRoutingLease,
  routingExamples,
  routingLeases,
  spaces,
  tenants,
  withTenantTx,
} from '../src/index.js';

async function seedTenant() {
  const tenantId = randomUUID();
  await withTenantTx(tenantId, (tx) =>
    tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}` })
  );
  return tenantId;
}

describe('routing schema', () => {
  it('gives the lease to one holder until it expires or is released', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const take = (holder: string, seconds = 300) =>
      withTenantTx(tenantId, (tx) => acquireRoutingLease(tx, tenantId, holder, seconds));

    expect(await take('w1')).toBe(true);
    expect(await take('w2')).toBe(false);
    // The holder may renew its own lease.
    expect(await take('w1')).toBe(true);

    await withTenantTx(tenantId, (tx) => releaseRoutingLease(tx, tenantId, 'w2'));
    expect(await take('w2')).toBe(false);
    await withTenantTx(tenantId, (tx) => releaseRoutingLease(tx, tenantId, 'w1'));
    expect(await take('w2')).toBe(true);

    await withTenantTx(tenantId, (tx) =>
      tx.update(routingLeases).set({ expiresAt: new Date(Date.now() - 1000) })
    );
    expect(await take('w3')).toBe(true);
  });

  it('stores a capture citation without a version', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const userId = randomUUID();
    await withTenantTx(tenantId, async (tx) => {
      const [space] = await tx
        .insert(spaces)
        .values({ tenantId, name: 'Eng', slug: 'eng', createdBy: userId })
        .returning();
      const [doc] = await tx
        .insert(documents)
        .values({ tenantId, spaceId: space!.id, kind: 'page', title: 'Billing', createdByType: 'user', createdBy: userId })
        .returning();
      const [capture] = await tx
        .insert(captures)
        .values({ tenantId, senderType: 'user', senderId: userId, channel: 'console', text: 'Billing uses Adyen.' })
        .returning();
      await tx.insert(citations).values({
        tenantId,
        pageId: doc!.id,
        blockId: 'b1',
        sourceKind: 'capture',
        captureId: capture!.id,
        quote: 'Billing uses Adyen.',
        createdByType: 'agent',
        createdBy: randomUUID(),
      });
    });
    const rows = await withTenantTx(tenantId, (tx) => tx.select().from(citations));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceKind: 'capture', sourceVersionId: null, state: 'ok' });
  });

  it('accepts the router agent kind', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    await withTenantTx(tenantId, (tx) =>
      tx.insert(agents).values({ tenantId, name: 'Routing engine', kind: 'router', createdBy: randomUUID() })
    );
    const rows = await withTenantTx(tenantId, (tx) => tx.select().from(agents));
    expect(rows[0]!.kind).toBe('router');
  });

  it('a capture keeps its shape and document fields; a document change has no fact', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const userId = randomUUID();
    const options = [{ pageId: randomUUID(), title: 'Client - George', spaceId: randomUUID(), spaceName: 'Clients' }];
    await withTenantTx(tenantId, async (tx) => {
      const [space] = await tx.insert(spaces).values({ tenantId, name: 'Clients', slug: 'clients', createdBy: userId }).returning();
      const [doc] = await tx
        .insert(documents)
        .values({ tenantId, spaceId: space!.id, kind: 'page', title: '14Oct', createdByType: 'user', createdBy: userId })
        .returning();
      const [capture] = await tx
        .insert(captures)
        .values({
          tenantId,
          senderType: 'user',
          senderId: userId,
          channel: 'console',
          text: 'Oct 14 meeting',
          shapeMode: 'document',
          shape: 'document',
          subject: 'Ryko',
          documentTitle: '14Oct',
          documentPageId: doc!.id,
          documentOutcome: 'created',
          documentReason: null,
          documentOptions: options,
        })
        .returning();
      const [fact] = await tx
        .insert(captureFacts)
        .values({ tenantId, captureId: capture!.id, ordinal: 0, statement: 'Shop the look.', kind: 'new', outcome: 'filed_in_document' })
        .returning();
      await tx.insert(captureChanges).values({
        tenantId,
        captureId: capture!.id,
        factId: null,
        documentId: doc!.id,
        spaceId: space!.id,
        blockId: 'b1',
        op: 'create_page',
        afterMarkdown: 'Oct 14 meeting',
      });
      await tx.insert(routingExamples).values({
        tenantId,
        spaceId: space!.id,
        kind: 'document',
        statement: 'Ryko 14Oct',
        statementEmbedding: new Array(2560).fill(0.01),
        chosenDocumentId: doc!.id,
        createdBy: userId,
      });
      expect(fact!.outcome).toBe('filed_in_document');
    });
    const [capture] = await withTenantTx(tenantId, (tx) => tx.select().from(captures));
    expect(capture).toMatchObject({
      shapeMode: 'document',
      shape: 'document',
      subject: 'Ryko',
      documentTitle: '14Oct',
      documentOutcome: 'created',
      documentOptions: options,
      documentParentChoice: null,
      documentSpaceChoice: null,
    });
    const [change] = await withTenantTx(tenantId, (tx) => tx.select().from(captureChanges));
    expect(change!.factId).toBeNull();
    const [example] = await withTenantTx(tenantId, (tx) => tx.select().from(routingExamples));
    expect(example!.kind).toBe('document');
  });

  it('a capture defaults to the auto shape mode', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx.insert(captures).values({ tenantId, senderType: 'user', senderId: randomUUID(), channel: 'console', text: 'x' }).returning()
    );
    expect(row).toMatchObject({ shapeMode: 'auto', shape: null, documentOutcome: null });
  });
});
