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
  /** The most used spelling among the mentions the actor can read. */
  name: string;
  kind: EntityKind;
  match: 'exact' | 'trigram';
  score: number;
}

/**
 * Entities named like `name`, matched only against the spellings recorded on
 * mentions in the filter's spaces (exact, then trigram within
 * `ENTITY_MATCH`, in both directions). The returned name is likewise a
 * readable spelling: an entity, alias or full name known only from a space
 * the actor cannot read never surfaces.
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
      WITH readable AS (
        SELECT m.entity_id, u.key, u.surface
          FROM entity_mentions m, unnest(m.surface_keys, m.surfaces) AS u(key, surface)
         WHERE m.tenant_id = ${f.tenantId}::uuid AND m.space_id = ANY(${sql.param(f.spaceIds)}::uuid[])
      ),
      matched AS (
        SELECT entity_id,
               CASE WHEN key = ${n} THEN 'exact' ELSE 'trigram' END AS match,
               greatest(similarity(key, ${n}), word_similarity(${n}, key), word_similarity(key, ${n})) AS score
          FROM readable
         WHERE key = ${n}
            OR similarity(key, ${n}) >= ${ENTITY_MATCH.trigram}
            OR word_similarity(${n}, key) >= ${ENTITY_MATCH.wordTrigram}
            OR word_similarity(key, ${n}) >= ${ENTITY_MATCH.wordTrigram}
      ),
      best AS (
        SELECT DISTINCT ON (entity_id) entity_id, match, score
          FROM matched ORDER BY entity_id, (match = 'exact') DESC, score DESC
      ),
      display AS (
        SELECT DISTINCT ON (entity_id) entity_id, surface
          FROM (SELECT entity_id, surface, count(*) AS uses FROM readable GROUP BY entity_id, surface) s
         ORDER BY entity_id, uses DESC, surface
      )
      SELECT b.entity_id AS id, d.surface AS name, e.kind, b.match, b.score
        FROM best b
        JOIN display d ON d.entity_id = b.entity_id
        JOIN entities e ON e.tenant_id = ${f.tenantId}::uuid AND e.id = b.entity_id
       ORDER BY (b.match = 'exact') DESC, b.score DESC
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
