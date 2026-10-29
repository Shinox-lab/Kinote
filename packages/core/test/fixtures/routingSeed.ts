import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { createServerEditor } from '@kinote/shared';
import { and, eq } from 'drizzle-orm';
import { captures, collectionFields, collections, documents, memberships, pageFieldValues, pages, spaceGrants, spaces, users, withTenantTx } from '@kinote/db';
import { FIELDS_MAP, type FieldDef, type FieldType } from '@kinote/contracts';
import { flattenBlocks, type BlockLike } from '@kinote/shared';
import {
  DeterministicEmbeddingProvider,
  DeterministicPlacementModel,
  buildPageCard,
  collectionFieldDefs,
  extractVersionEntities,
} from '../../src/index.js';
import { encodePageYDoc } from '../../../../apps/api/src/routes/pages.js';
import { addSpace, indexPageVersion, seedTenant, type World } from './placementSeed.js';

export const model = new DeterministicPlacementModel();
export const embedder = new DeterministicEmbeddingProvider();
const editor = createServerEditor();

async function addUserRow(tenantId: string, userId: string, role: 'owner' | 'admin' | 'member' | 'viewer') {
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(users).values({ id: userId, email: `${userId}@example.com`, name: `User ${userId.slice(0, 4)}`, passwordHash: 'x' });
    await tx.insert(memberships).values({ tenantId, userId, role });
  });
}

/** A tenant whose owner is a real member (the engine reads the sender's membership). */
export async function routingWorld(): Promise<World> {
  const w = await seedTenant();
  await addUserRow(w.tenantId, w.userId, 'owner');
  return w;
}

/** A member with the given space grants. */
export async function addMember(w: World, grants: Array<[string, 'viewer' | 'editor' | 'reviewer' | 'admin']>) {
  const userId = randomUUID();
  await addUserRow(w.tenantId, userId, 'member');
  await withTenantTx(w.tenantId, async (tx) => {
    for (const [spaceId, role] of grants) {
      await tx.insert(spaceGrants).values({ tenantId: w.tenantId, spaceId, principalType: 'user', principalId: userId, role });
    }
  });
  return userId;
}

export async function addRoutingSpace(w: World, opts: { name?: string; reviewRequired?: boolean; kind?: 'normal' | 'inbox' } = {}) {
  const id = await addSpace(w, opts.kind ?? 'normal');
  await withTenantTx(w.tenantId, (tx) =>
    tx
      .update(spaces)
      .set({ ...(opts.name ? { name: opts.name } : {}), reviewRequired: opts.reviewRequired ?? false })
      .where(and(eq(spaces.tenantId, w.tenantId), eq(spaces.id, id)))
  );
  return id;
}

/** An indexed page with a card, entities and a live Yjs state holding `markdown`. */
export async function livePage(w: World, spaceId: string, title: string, markdown: string, opts: { parentId?: string } = {}) {
  const { documentId, versionId } = await indexPageVersion(w, spaceId, title, markdown);
  if (opts.parentId) {
    await withTenantTx(w.tenantId, (tx) =>
      tx
        .update(documents)
        .set({ parentId: opts.parentId })
        .where(and(eq(documents.tenantId, w.tenantId), eq(documents.id, documentId)))
    );
  }
  await buildPageCard({ tenantId: w.tenantId, versionId }, model, embedder);
  await extractVersionEntities({ tenantId: w.tenantId, versionId }, model, embedder);
  const ydocState = await encodePageYDoc(title, markdown);
  await withTenantTx(w.tenantId, (tx) =>
    tx.insert(pages).values({ tenantId: w.tenantId, documentId, spaceId, slug: `p-${documentId}`, ydocState })
  );
  return { documentId, versionId };
}

/** The live top-level blocks of a page. */
export async function liveBlocks(w: World, documentId: string) {
  const [row] = await withTenantTx(w.tenantId, (tx) =>
    tx.select().from(pages).where(and(eq(pages.tenantId, w.tenantId), eq(pages.documentId, documentId)))
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row!.ydocState);
  return editor.yDocToBlocks(doc, 'document-store') as BlockLike[];
}

/** The id of the one live block whose text contains `text`. */
export async function liveBlockId(w: World, documentId: string, text: string): Promise<string> {
  const found = flattenBlocks(await liveBlocks(w, documentId)).filter((b) => b.text.includes(text));
  if (found.length !== 1) throw new Error(`expected one block containing "${text}", found ${found.length}`);
  return found[0]!.id;
}

export async function addCapture(
  w: World,
  senderId: string,
  text: string,
  scope: { spaceId?: string; pageId?: string; shapeMode?: 'auto' | 'document' | 'updates' } = {}
) {
  const [row] = await withTenantTx(w.tenantId, (tx) =>
    tx
      .insert(captures)
      .values({
        tenantId: w.tenantId,
        senderType: 'user',
        senderId,
        channel: 'console',
        text,
        scopeSpaceId: scope.spaceId ?? null,
        scopePageId: scope.pageId ?? null,
        shapeMode: scope.shapeMode ?? 'auto',
      })
      .returning()
  );
  return row!.id;
}

/** Makes `documentId` a collection with `fields` (choices get ids `<field name>:<choice name>` lower-cased). */
export async function addCollection(
  w: World,
  documentId: string,
  fields: Array<{ name: string; type: FieldType; choices?: string[] }>
): Promise<FieldDef[]> {
  return withTenantTx(w.tenantId, async (tx) => {
    await tx.insert(collections).values({ tenantId: w.tenantId, documentId, createdBy: w.userId });
    await tx.insert(collectionFields).values(
      fields.map((f, i) => ({
        tenantId: w.tenantId,
        collectionId: documentId,
        name: f.name,
        type: f.type,
        position: `a${i}`,
        options: f.choices
          ? { choices: f.choices.map((c) => ({ id: `${f.name}:${c}`.toLowerCase(), name: c, color: 'gray' as const })) }
          : {},
      }))
    );
    return collectionFieldDefs(tx, w.tenantId, documentId);
  });
}

/** Sets field values on the stored live document and the projection, as collab would (null clears). */
export async function setLiveFields(w: World, pageId: string, values: Record<string, unknown>) {
  await withTenantTx(w.tenantId, async (tx) => {
    const [row] = await tx.select().from(pages).where(and(eq(pages.tenantId, w.tenantId), eq(pages.documentId, pageId)));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row!.ydocState);
    const map = doc.getMap(FIELDS_MAP);
    for (const [k, v] of Object.entries(values)) {
      if (v === null) map.delete(k);
      else map.set(k, v);
    }
    await tx
      .update(pages)
      .set({ ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)) })
      .where(and(eq(pages.tenantId, w.tenantId), eq(pages.documentId, pageId)));
    await tx.delete(pageFieldValues).where(and(eq(pageFieldValues.tenantId, w.tenantId), eq(pageFieldValues.pageId, pageId)));
    const kept = Object.entries(map.toJSON());
    if (kept.length > 0) {
      await tx.insert(pageFieldValues).values(kept.map(([fieldId, value]) => ({ tenantId: w.tenantId, pageId, fieldId, value })));
    }
  });
}
