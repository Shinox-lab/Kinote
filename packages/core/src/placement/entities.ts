import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  versions,
  spaces,
  chunks,
  entities,
  entityMentions,
  entityEdges,
  entityExtractionCache,
  lockDocument,
  normalizeEntityName,
  rowsOf,
  NonRetryableError,
  type DbTransaction,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import type { EmbeddingProvider } from '../embedding.js';
import type { EntityKind, ExtractedEdge, ExtractedEntity, PlacementModel } from './model.js';

export type ExtractEntitiesResult =
  | { outcome: 'extracted'; entities: number; edges: number }
  | { outcome: 'skipped'; reason: 'not_indexed' | 'inbox' | 'archived' };

/**
 * When an extracted name may be an existing entity: a trigram candidate
 * (`similarity` or, for a name that is part of a longer one, `word_similarity`)
 * whose name embedding is within `maxCosineDistance`, confirmed by the model.
 * Settings, to be tuned by the evaluation set.
 */
export const ENTITY_MATCH = { trigram: 0.6, wordTrigram: 0.8, maxCosineDistance: 0.35 } as const;

interface ChunkResult {
  chunkId: string;
  blockIds: string[];
  text: string;
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
}

interface Candidate {
  id: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  distance: number | null;
}

/** How each distinct normalized name resolved in phase B. */
type Resolution = { existingId: string } | { create: true };

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 1 : 1 - dot / Math.sqrt(na * nb);
}

/** Every word of the shorter normalized name appears in the longer one. */
function tokensWithin(a: string, b: string): boolean {
  const [short, long] = a.split(' ').length <= b.split(' ').length ? [a, b] : [b, a];
  const words = new Set(long.split(' '));
  return short.split(' ').every((w) => words.has(w));
}

/** Exact name or alias matches first, then up to three trigram candidates. */
async function findCandidates(tx: DbTransaction, tenantId: string, normalized: string): Promise<{
  exact: Candidate | null;
  fuzzy: Array<Candidate & { embedding: number[] }>;
}> {
  const [exact] = await tx
    .select({ id: entities.id, name: entities.name, kind: entities.kind, aliases: entities.aliases })
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        sql`(${entities.normalizedName} = ${normalized} OR ${normalized} = ANY(${entities.aliases}))`
      )
    )
    .limit(1);
  if (exact) return { exact: { ...exact, distance: null }, fuzzy: [] };

  const fuzzy = await tx
    .select({
      id: entities.id,
      name: entities.name,
      kind: entities.kind,
      aliases: entities.aliases,
      embedding: entities.nameEmbedding,
    })
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        sql`(similarity(${entities.normalizedName}, ${normalized}) >= ${ENTITY_MATCH.trigram}
          OR word_similarity(${normalized}, ${entities.normalizedName}) >= ${ENTITY_MATCH.wordTrigram}
          OR word_similarity(${entities.normalizedName}, ${normalized}) >= ${ENTITY_MATCH.wordTrigram})`
      )
    )
    .orderBy(sql`similarity(${entities.normalizedName}, ${normalized}) DESC`)
    .limit(3);
  return { exact: null, fuzzy: fuzzy.map((f) => ({ ...f, distance: null })) };
}

/** The one tenant member whose name or email local part is `normalized`, if exactly one. */
async function memberFor(tx: DbTransaction, tenantId: string, normalized: string): Promise<string | null> {
  const rows = rowsOf<{ user_id: string }>(
    await tx.execute(sql`
      SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ${tenantId}::uuid
         AND (lower(u.name) = ${normalized} OR lower(split_part(u.email, '@', 1)) = ${normalized})
       LIMIT 2`)
  );
  return rows.length === 1 ? rows[0]!.user_id : null;
}

/**
 * Builds the entity graph rows of an indexed version (page or file), in
 * `indexVersion`'s three phases:
 *
 * A. read the version, its document, space and chunks, and the extraction
 *    cache (skip unless still the indexed version outside the Inbox);
 * B. with no transaction open, extract uncached chunks (caching each at
 *    once), group this document's own spelling variants, then resolve each
 *    group's fullest name: exact name or alias, else trigram candidates within
 *    `ENTITY_MATCH` that the model confirms are the same, else a new entity;
 * C. under the document lock, re-check, then replace the document's mentions
 *    and edges and delete entities the document alone mentioned.
 *
 * A model failure throws before phase C, so the previous graph stays.
 */
export async function extractVersionEntities(
  params: { tenantId: string; versionId: string },
  model: PlacementModel,
  embedder: EmbeddingProvider
): Promise<ExtractEntitiesResult> {
  const { tenantId, versionId } = params;

  // Phase A.
  const loaded = await withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select({ version: versions, document: documents, spaceKind: spaces.kind })
      .from(versions)
      .innerJoin(documents, and(eq(documents.tenantId, versions.tenantId), eq(documents.id, versions.documentId)))
      .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));
    if (!row) throw new AppError('version_not_found');
    const chunkRows = await tx
      .select({ id: chunks.id, text: chunks.text, headingPath: chunks.headingPath, blockIds: chunks.blockIds, contentHash: chunks.contentHash })
      .from(chunks)
      .where(and(eq(chunks.tenantId, tenantId), eq(chunks.versionId, versionId)))
      .orderBy(chunks.ordinal);
    const hashes = [...new Set(chunkRows.map((c) => c.contentHash))];
    const cached =
      hashes.length === 0
        ? []
        : await tx
            .select({ contentHash: entityExtractionCache.contentHash, result: entityExtractionCache.result })
            .from(entityExtractionCache)
            .where(
              and(
                eq(entityExtractionCache.tenantId, tenantId),
                eq(entityExtractionCache.model, model.model),
                inArray(entityExtractionCache.contentHash, hashes)
              )
            );
    return { ...row, chunkRows, cached };
  });
  const { version, document } = loaded;
  if (document.indexedVersionId !== versionId) return { outcome: 'skipped', reason: 'not_indexed' };
  if (document.archivedAt) return { outcome: 'skipped', reason: 'archived' };
  if (loaded.spaceKind === 'inbox') return { outcome: 'skipped', reason: 'inbox' };

  // Phase B: extraction.
  const cache = new Map(
    loaded.cached.map((c) => [c.contentHash, c.result as { entities: ExtractedEntity[]; edges: ExtractedEdge[] }])
  );
  const results: ChunkResult[] = [];
  for (const c of loaded.chunkRows) {
    let out = cache.get(c.contentHash);
    if (!out) {
      out = await model.extractEntities({ title: version.title, headingPath: c.headingPath, text: c.text });
      cache.set(c.contentHash, out);
      // Cached at once (content-addressed, so safe outside phase C): a later
      // chunk's failure does not make the retry pay for this one again.
      const result = out;
      await withTenantTx(tenantId, (tx) =>
        tx
          .insert(entityExtractionCache)
          .values({ tenantId, model: model.model, contentHash: c.contentHash, result })
          .onConflictDoNothing({
            target: [entityExtractionCache.tenantId, entityExtractionCache.model, entityExtractionCache.contentHash],
          })
      );
    }
    results.push({ chunkId: c.id, blockIds: c.blockIds, text: c.text, ...out });
  }

  // Phase B: resolution. One extracted form (and context) per normalized name.
  const named = new Map<string, { entity: ExtractedEntity; context: string }>();
  for (const r of results) {
    for (const e of r.entities) {
      const key = normalizeEntityName(e.name);
      if (key !== '' && !named.has(key)) named.set(key, { entity: e, context: r.text });
    }
  }
  const keys = [...named.keys()];
  const candidates = await withTenantTx(tenantId, async (tx) => {
    const out = new Map<string, Awaited<ReturnType<typeof findCandidates>>>();
    for (const key of keys) out.set(key, await findCandidates(tx, tenantId, key));
    return out;
  });
  const vectors = keys.length === 0 ? [] : await embedder.embed(keys.map((k) => named.get(k)!.entity.name), 'document');
  if (vectors.length !== keys.length || vectors.some((v) => !Array.isArray(v) || v.length !== embedder.dimensions)) {
    throw new NonRetryableError('embedding provider returned malformed vectors for entity names');
  }
  const embeddingOf = new Map(keys.map((k, i) => [k, vectors[i]!]));

  // Variants inside this document first ("Aisha Rahman" ... "Aisha"): the
  // fullest name of a group stands for it, the others become its aliases.
  const groupOf = new Map<string, string>();
  const representatives: string[] = [];
  const byFullness = [...keys].sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length);
  for (const key of byFullness) {
    let rep: string | null = null;
    for (const candidate of representatives) {
      if (!tokensWithin(key, candidate)) continue;
      if (cosineDistance(embeddingOf.get(key)!, embeddingOf.get(candidate)!) > ENTITY_MATCH.maxCosineDistance) continue;
      const { same } = await model.sameEntity({
        a: named.get(key)!.entity,
        b: named.get(candidate)!.entity,
        context: named.get(key)!.context,
      });
      if (same) {
        rep = candidate;
        break;
      }
    }
    if (rep) groupOf.set(key, rep);
    else representatives.push(key);
  }

  const resolution = new Map<string, Resolution>();
  for (const key of representatives) {
    const found = candidates.get(key)!;
    if (found.exact) {
      resolution.set(key, { existingId: found.exact.id });
      continue;
    }
    let match: string | null = null;
    for (const candidate of found.fuzzy) {
      if (cosineDistance(embeddingOf.get(key)!, candidate.embedding) > ENTITY_MATCH.maxCosineDistance) continue;
      const { same } = await model.sameEntity({
        a: named.get(key)!.entity,
        b: { name: candidate.name, kind: candidate.kind, aliases: candidate.aliases },
        context: named.get(key)!.context,
      });
      if (same) {
        match = candidate.id;
        break;
      }
    }
    resolution.set(key, match ? { existingId: match } : { create: true });
  }

  // Phase C.
  return withTenantTx(tenantId, async (tx): Promise<ExtractEntitiesResult> => {
    const doc = await lockDocument(tx, tenantId, document.id);
    if (doc.indexedVersionId !== versionId) return { outcome: 'skipped', reason: 'not_indexed' };
    if (doc.archivedAt) return { outcome: 'skipped', reason: 'archived' };
    const [space] = await tx
      .select({ kind: spaces.kind })
      .from(spaces)
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, doc.spaceId)));
    if (space?.kind === 'inbox') return { outcome: 'skipped', reason: 'inbox' };

    const previous = await previousEntityIds(tx, tenantId, doc.id);
    await tx.delete(entityEdges).where(and(eq(entityEdges.tenantId, tenantId), eq(entityEdges.documentId, doc.id)));
    await tx
      .delete(entityMentions)
      .where(and(eq(entityMentions.tenantId, tenantId), eq(entityMentions.documentId, doc.id)));

    const idOf = new Map<string, string>();
    for (const key of representatives) {
      const { entity } = named.get(key)!;
      const resolved = resolution.get(key)!;
      if ('existingId' in resolved) {
        const [existing] = await tx
          .select({ id: entities.id, normalizedName: entities.normalizedName, aliases: entities.aliases })
          .from(entities)
          .where(and(eq(entities.tenantId, tenantId), eq(entities.id, resolved.existingId)));
        if (existing) {
          if (existing.normalizedName !== key && !existing.aliases.includes(key)) {
            await tx
              .update(entities)
              .set({ aliases: sql`array_append(${entities.aliases}, ${key})` })
              .where(and(eq(entities.tenantId, tenantId), eq(entities.id, existing.id)));
          }
          idOf.set(key, existing.id);
          continue;
        }
        // Deleted as an orphan since phase B: create it again below.
      }
      const userId = entity.kind === 'person' ? await memberFor(tx, tenantId, key) : null;
      const [row] = await tx
        .insert(entities)
        .values({
          tenantId,
          kind: entity.kind,
          name: entity.name,
          normalizedName: key,
          aliases: entity.aliases.map(normalizeEntityName).filter((a) => a !== '' && a !== key),
          nameEmbedding: embeddingOf.get(key)!,
          userId,
        })
        .onConflictDoUpdate({
          target: [entities.tenantId, entities.kind, entities.normalizedName],
          set: { name: sql`${entities.name}` },
        })
        .returning({ id: entities.id });
      idOf.set(key, row!.id);
    }
    for (const [key, rep] of groupOf) {
      const id = idOf.get(rep)!;
      await tx
        .update(entities)
        .set({ aliases: sql`array_append(${entities.aliases}, ${key})` })
        .where(
          and(
            eq(entities.tenantId, tenantId),
            eq(entities.id, id),
            sql`${entities.normalizedName} <> ${key}`,
            sql`NOT (${key} = ANY(${entities.aliases}))`
          )
        );
      idOf.set(key, id);
    }

    const mentionRows = [];
    const edgeRows = [];
    for (const r of results) {
      // One mention per entity per chunk, carrying every spelling the chunk used.
      const byEntity = new Map<string, { surfaces: string[]; surfaceKeys: string[] }>();
      for (const e of r.entities) {
        const key = normalizeEntityName(e.name);
        const id = idOf.get(key);
        if (!id) continue;
        const forms = byEntity.get(id) ?? { surfaces: [], surfaceKeys: [] };
        if (!forms.surfaceKeys.includes(key)) {
          forms.surfaces.push(e.name.trim());
          forms.surfaceKeys.push(key);
        }
        byEntity.set(id, forms);
      }
      for (const [id, forms] of byEntity) {
        mentionRows.push({ tenantId, entityId: id, documentId: doc.id, versionId, chunkId: r.chunkId, spaceId: doc.spaceId, blockIds: r.blockIds, ...forms });
      }
      for (const edge of r.edges) {
        const from = idOf.get(normalizeEntityName(edge.from));
        const to = idOf.get(normalizeEntityName(edge.to));
        if (!from || !to || from === to) continue;
        edgeRows.push({ tenantId, fromEntityId: from, toEntityId: to, type: edge.type, documentId: doc.id, versionId, chunkId: r.chunkId, spaceId: doc.spaceId });
      }
    }
    if (mentionRows.length > 0) await tx.insert(entityMentions).values(mentionRows);
    if (edgeRows.length > 0) await tx.insert(entityEdges).values(edgeRows);
    await deleteOrphanEntities(tx, tenantId, previous);

    return {
      outcome: 'extracted',
      entities: new Set(mentionRows.map((m) => m.entityId)).size,
      edges: edgeRows.length,
    };
  });
}

/** Entities the document's current mentions and edges point at. */
export async function previousEntityIds(tx: DbTransaction, tenantId: string, documentId: string): Promise<string[]> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT entity_id AS id FROM entity_mentions WHERE tenant_id = ${tenantId}::uuid AND document_id = ${documentId}::uuid
      UNION SELECT from_entity_id FROM entity_edges WHERE tenant_id = ${tenantId}::uuid AND document_id = ${documentId}::uuid
      UNION SELECT to_entity_id FROM entity_edges WHERE tenant_id = ${tenantId}::uuid AND document_id = ${documentId}::uuid`)
  );
  return rows.map((r) => r.id);
}

/**
 * Deletes those of `ids` nothing mentions or connects any more. A concurrent
 * writer adding a mention makes the foreign key fail the transaction (the job
 * retries) rather than losing that mention.
 */
export async function deleteOrphanEntities(tx: DbTransaction, tenantId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`
    DELETE FROM entities e
     WHERE e.tenant_id = ${tenantId}::uuid
       AND e.id = ANY(${sql.param(ids)}::uuid[])
       AND NOT EXISTS (SELECT 1 FROM entity_mentions m WHERE m.tenant_id = e.tenant_id AND m.entity_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM entity_edges g WHERE g.tenant_id = e.tenant_id AND (g.from_entity_id = e.id OR g.to_entity_id = e.id))`);
}
