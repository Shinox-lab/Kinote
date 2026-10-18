import { sql, type SQL } from 'drizzle-orm';
import { rowsOf, type DbTransaction } from '@living-wiki/db';
import { principalKey, type Actor } from '@living-wiki/core';

export interface SearchPassage {
  chunkId: string;
  documentId: string;
  versionId: string;
  versionNumber: number;
  versionTitle: string;
  text: string;
  headingPath: string[];
  blockIds: string[];
  citeAs: string;
  rrfScore: number;
}

/** Candidates each branch contributes to reciprocal rank fusion. */
export const BRANCH_LIMIT = 40;
/** Reciprocal rank fusion constant: score = Σ 1 / (k + rank). */
const RRF_K = 60;

/**
 * Who may see which chunk, decided on the chunk row alone (permissions inside
 * the query, before ranking): the readable spaces, and in the Inbox only the
 * actor's own items unless the actor is a tenant owner or admin.
 */
export interface ChunkFilter {
  tenantId: string;
  spaceIds: string[];
  inboxSpaceId: string;
  isTenantAdmin: boolean;
  /** The actor's principal key, compared with `chunks.inbox_owner`. */
  me: string;
}

export function chunkFilterFor(
  actor: Actor,
  readableSpaceIds: string[],
  inboxSpaceId: string
): ChunkFilter {
  return {
    tenantId: actor.tenantId,
    spaceIds: readableSpaceIds,
    inboxSpaceId,
    isTenantAdmin:
      actor.principalType === 'user' &&
      (actor.tenantRole === 'owner' || actor.tenantRole === 'admin'),
    me: principalKey(actor.principalType, actor.principalId),
  };
}

function chunkWhere(f: ChunkFilter): SQL {
  return sql`tenant_id = NULLIF(${f.tenantId}, '')::uuid
      AND space_id = ANY(${sql.param(f.spaceIds)}::uuid[])
      AND (space_id <> ${f.inboxSpaceId}::uuid OR ${f.isTenantAdmin}::boolean OR inbox_owner = ${f.me})`;
}

/**
 * The vector branch: nearest chunks by cosine distance, ordered over `chunks`
 * directly (no join, no CTE under the ORDER BY) so the planner can use
 * `chunks_embedding_hnsw_idx`. Run with `hnsw.iterative_scan = relaxed_order`
 * so the filter does not under-return; `distance` lets the caller restore the
 * exact order relaxed scans may loosen.
 */
export function vectorBranchSql(f: ChunkFilter, vectorLiteral: string, limit = BRANCH_LIMIT): SQL {
  return sql`SELECT id, embedding <=> ${vectorLiteral}::halfvec AS distance
    FROM chunks
    WHERE ${chunkWhere(f)}
    ORDER BY embedding <=> ${vectorLiteral}::halfvec
    LIMIT ${limit}`;
}

/** The full-text branch: same filter, `chunks.tsv` (GIN-indexed) only, ranked by ts_rank_cd. */
export function ftsBranchSql(f: ChunkFilter, queryText: string, limit = BRANCH_LIMIT): SQL {
  return sql`SELECT id, ts_rank_cd(tsv, websearch_to_tsquery('simple', ${queryText})) AS score
    FROM chunks
    WHERE ${chunkWhere(f)}
      AND tsv @@ websearch_to_tsquery('simple', ${queryText})
    ORDER BY score DESC, id
    LIMIT ${limit}`;
}

/**
 * Hybrid search: both branches rank permitted chunks only, reciprocal rank
 * fusion (k = 60) merges them, and `versions` is joined for the final top
 * rows alone (title, number and date for `citeAs`).
 */
export function searchSql(
  f: ChunkFilter,
  queryText: string,
  vectorLiteral: string,
  limit: number
): SQL {
  return sql`
    WITH vector_hits AS (${vectorBranchSql(f, vectorLiteral)}),
    vector_ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY distance, id) AS rank_v FROM vector_hits
    ),
    fts_hits AS (${ftsBranchSql(f, queryText)}),
    fts_ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY score DESC, id) AS rank_f FROM fts_hits
    ),
    rrf AS (
      SELECT
        COALESCE(v.id, ft.id) AS chunk_id,
        COALESCE(1.0 / (${RRF_K} + v.rank_v), 0.0) + COALESCE(1.0 / (${RRF_K} + ft.rank_f), 0.0) AS rrf_score
      FROM vector_ranked v
      FULL OUTER JOIN fts_ranked ft ON v.id = ft.id
    ),
    top AS (
      SELECT chunk_id, rrf_score FROM rrf ORDER BY rrf_score DESC, chunk_id LIMIT ${limit}
    )
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.version_id,
      c.text,
      c.heading_path,
      c.block_ids,
      ver.title AS version_title,
      ver.number AS version_number,
      to_char(ver.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated_date,
      top.rrf_score
    FROM top
    JOIN chunks c ON c.id = top.chunk_id AND c.tenant_id = NULLIF(${f.tenantId}, '')::uuid
    JOIN versions ver ON ver.id = c.version_id AND ver.tenant_id = c.tenant_id
    ORDER BY top.rrf_score DESC, c.id
  `;
}

export async function searchWiki(
  tx: DbTransaction,
  actor: Actor,
  readableSpaceIds: string[],
  inboxSpaceId: string,
  queryText: string,
  queryEmbedding: number[],
  limit = 10
): Promise<SearchPassage[]> {
  if (readableSpaceIds.length === 0) return [];

  const filter = chunkFilterFor(actor, readableSpaceIds, inboxSpaceId);
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  // Enable pgvector 0.8 iterative index scans so filtered queries do not under-return rows
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);

  const rows = await tx.execute(searchSql(filter, queryText, vectorLiteral, limit));

  return rowsOf<any>(rows).map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    versionId: r.version_id,
    versionNumber: Number(r.version_number),
    versionTitle: r.version_title,
    text: r.text,
    headingPath: r.heading_path,
    blockIds: r.block_ids,
    citeAs: `${r.version_title} (v${r.version_number}, updated ${r.updated_date})`,
    rrfScore: Number(r.rrf_score),
  }));
}
