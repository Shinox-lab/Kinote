import { sql } from 'drizzle-orm';
import { normalizeEntityName, rowsOf, type DbTransaction } from '@living-wiki/db';
import { ENTITY_MATCH } from './entities.js';
import type { EntityKind } from './model.js';

/**
 * Who may be placed into or found through: the actor's readable spaces with
 * the Inbox already removed (R17). Every query below filters on it before
 * ranking or following anything (R7, rule 12).
 */
export interface PlacementFilter {
  tenantId: string;
  spaceIds: string[];
}

export interface CardHit {
  documentId: string;
  spaceId: string;
  distance: number;
}

/**
 * Nearest page cards by cosine distance, ordered over `page_cards` alone so
 * the HNSW index stays usable; iterative scans keep the space filter from
 * under-returning (as the search vector branch does).
 */
export async function searchPageCards(
  tx: DbTransaction,
  f: PlacementFilter,
  vector: number[],
  limit = 20
): Promise<CardHit[]> {
  if (f.spaceIds.length === 0) return [];
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
  const literal = `[${vector.join(',')}]`;
  const rows = rowsOf<{ document_id: string; space_id: string; distance: number }>(
    await tx.execute(sql`
      SELECT document_id, space_id, embedding <=> ${literal}::halfvec AS distance
        FROM page_cards
       WHERE tenant_id = ${f.tenantId}::uuid AND space_id = ANY(${sql.param(f.spaceIds)}::uuid[])
       ORDER BY embedding <=> ${literal}::halfvec
       LIMIT ${limit}`)
  );
  return rows
    .map((r) => ({ documentId: r.document_id, spaceId: r.space_id, distance: Number(r.distance) }))
    .sort((a, b) => a.distance - b.distance);
}

export interface EntityHit {
  entityId: string;
  name: string;
  kind: EntityKind;
  match: 'exact' | 'alias' | 'trigram';
  score: number;
}

/**
 * Entities named like `name` (exact, alias, then trigram within
 * `ENTITY_MATCH`), only those with a mention in the filter's spaces: an
 * entity known only from a space the actor cannot read does not exist for them.
 */
export async function findEntities(
  tx: DbTransaction,
  f: PlacementFilter,
  name: string,
  limit = 5
): Promise<EntityHit[]> {
  const n = normalizeEntityName(name);
  if (n === '' || f.spaceIds.length === 0) return [];
  const rows = rowsOf<{ id: string; name: string; kind: EntityKind; match: EntityHit['match']; score: number }>(
    await tx.execute(sql`
      SELECT e.id, e.name, e.kind,
             CASE WHEN e.normalized_name = ${n} THEN 'exact'
                  WHEN ${n} = ANY(e.aliases) THEN 'alias'
                  ELSE 'trigram' END AS match,
             greatest(similarity(e.normalized_name, ${n}), word_similarity(${n}, e.normalized_name)) AS score
        FROM entities e
       WHERE e.tenant_id = ${f.tenantId}::uuid
         AND (e.normalized_name = ${n}
              OR ${n} = ANY(e.aliases)
              OR similarity(e.normalized_name, ${n}) >= ${ENTITY_MATCH.trigram}
              OR word_similarity(${n}, e.normalized_name) >= ${ENTITY_MATCH.wordTrigram})
         AND EXISTS (SELECT 1 FROM entity_mentions m
                      WHERE m.tenant_id = e.tenant_id AND m.entity_id = e.id
                        AND m.space_id = ANY(${sql.param(f.spaceIds)}::uuid[]))
       ORDER BY CASE WHEN e.normalized_name = ${n} THEN 0 WHEN ${n} = ANY(e.aliases) THEN 1 ELSE 2 END, score DESC
       LIMIT ${limit}`)
  );
  return rows.map((r) => ({ entityId: r.id, name: r.name, kind: r.kind, match: r.match, score: Number(r.score) }));
}

export interface GraphPageHit {
  documentId: string;
  spaceId: string;
  hops: 0 | 1 | 2;
  /** The reached entities this page mentions. */
  viaEntityIds: string[];
}

/**
 * Pages mentioning the seed entities (hops 0) or entities reached from them
 * through edges, in either direction, up to `maxHops`. Edges and mentions
 * outside the filter's spaces are never followed; each page keeps its
 * smallest hop count. Files and archived pages are left out (never edit
 * targets).
 */
export async function pagesForEntities(
  tx: DbTransaction,
  f: PlacementFilter,
  seedEntityIds: string[],
  maxHops: 1 | 2 = 1
): Promise<GraphPageHit[]> {
  if (seedEntityIds.length === 0 || f.spaceIds.length === 0) return [];
  const spaces = sql.param(f.spaceIds);
  const rows = rowsOf<{ document_id: string; space_id: string; hops: number; via: string[] }>(
    await tx.execute(sql`
      WITH RECURSIVE reach(entity_id, hops) AS (
        SELECT unnest(${sql.param(seedEntityIds)}::uuid[]), 0
        UNION
        SELECT CASE WHEN g.from_entity_id = r.entity_id THEN g.to_entity_id ELSE g.from_entity_id END, r.hops + 1
          FROM reach r
          JOIN entity_edges g
            ON g.tenant_id = ${f.tenantId}::uuid
           AND g.space_id = ANY(${spaces}::uuid[])
           AND (g.from_entity_id = r.entity_id OR g.to_entity_id = r.entity_id)
         WHERE r.hops < ${maxHops}
      ),
      nearest AS (SELECT entity_id, min(hops) AS hops FROM reach GROUP BY entity_id)
      SELECT m.document_id, m.space_id, min(n.hops)::int AS hops, array_agg(DISTINCT n.entity_id) AS via
        FROM nearest n
        JOIN entity_mentions m
          ON m.tenant_id = ${f.tenantId}::uuid AND m.entity_id = n.entity_id AND m.space_id = ANY(${spaces}::uuid[])
        JOIN documents d
          ON d.tenant_id = m.tenant_id AND d.id = m.document_id AND d.kind = 'page' AND d.archived_at IS NULL
       GROUP BY m.document_id, m.space_id
       ORDER BY hops, m.document_id`)
  );
  return rows.map((r) => ({
    documentId: r.document_id,
    spaceId: r.space_id,
    hops: r.hops as 0 | 1 | 2,
    viaEntityIds: Array.isArray(r.via) ? r.via : String(r.via).replace(/^\{|\}$/g, '').split(',').filter(Boolean),
  }));
}
