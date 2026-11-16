import { sql, type SQL } from 'drizzle-orm';
import { rowsOf, type DbTransaction } from '@kinote/db';
import { principalKey } from '../indexing/inboxOwner.js';
import type { Actor } from '../permissions.js';
import type { SearchPassage } from '@kinote/contracts';

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
  /**
   * The query vector's model: the vector branch ranks only chunks embedded with it (after an embedding model change,
   * older chunks are in another vector space until re-indexed). Unset: every chunk.
   */
  embeddingModel?: string;
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
  const sameModel = f.embeddingModel === undefined ? sql`` : sql` AND embedding_model = ${f.embeddingModel}`;
  return sql`SELECT id, embedding <=> ${vectorLiteral}::halfvec AS distance
    FROM chunks
    WHERE ${chunkWhere(f)}${sameModel}
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

/** Optional narrowing of hybrid search results; unset options keep the plain hybrid ranking. */
export interface SearchOptions {
  /** At most this many passages from one document (its best ones). */
  maxPerDocument?: number;
  /**
   * Drop a hit that only the vector branch found when its cosine distance from the query is above this, so an
   * off-topic query returns nothing instead of the nearest unrelated chunks. Keyword hits are always kept.
   */
  maxVectorDistance?: number;
}

/** The output columns for the final `top (chunk_id, rrf_score, vector_distance)` rows, newest version data joined. */
function passagesFrom(f: ChunkFilter): SQL {
  return sql`
    SELECT
      c.id AS chunk_id,
      c.document_id,
      c.version_id,
      c.space_id,
      d.icon,
      c.text,
      c.heading_path,
      c.block_ids,
      c.page_from,
      c.page_to,
      d.kind AS document_kind,
      ver.title AS version_title,
      ver.number AS version_number,
      to_char(ver.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated_date,
      top.rrf_score,
      top.vector_distance
    FROM top
    JOIN chunks c ON c.id = top.chunk_id AND c.tenant_id = NULLIF(${f.tenantId}, '')::uuid
    JOIN versions ver ON ver.id = c.version_id AND ver.tenant_id = c.tenant_id
    JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
    ORDER BY top.rrf_score DESC, c.id`;
}

/**
 * The `top` CTE body over a ranked CTE `name (chunk_id, rrf_score, vector_distance)`: with `maxPerDocument`,
 * each document's rows are ranked by score and only its first N kept, before the final LIMIT.
 */
function topOf(f: ChunkFilter, name: SQL, limit: number, maxPerDocument: number | undefined): SQL {
  if (maxPerDocument === undefined) {
    return sql`SELECT chunk_id, rrf_score, vector_distance FROM ${name} ORDER BY rrf_score DESC, chunk_id LIMIT ${limit}`;
  }
  return sql`SELECT chunk_id, rrf_score, vector_distance FROM (
      SELECT r.chunk_id, r.rrf_score, r.vector_distance,
        ROW_NUMBER() OVER (PARTITION BY c.document_id ORDER BY r.rrf_score DESC, r.chunk_id) AS doc_rank
      FROM ${name} r
      JOIN chunks c ON c.id = r.chunk_id AND c.tenant_id = NULLIF(${f.tenantId}, '')::uuid
    ) per_doc
    WHERE doc_rank <= ${maxPerDocument}
    ORDER BY rrf_score DESC, chunk_id
    LIMIT ${limit}`;
}

/**
 * Hybrid search: both branches rank permitted chunks only, reciprocal rank
 * fusion (k = 60) merges them, and `versions` is joined for the final top
 * rows alone (title, number and date for `citeAs`). `opts` can drop distant
 * vector-only hits and cap passages per document.
 */
export function searchSql(
  f: ChunkFilter,
  queryText: string,
  vectorLiteral: string,
  limit: number,
  opts: SearchOptions = {}
): SQL {
  const cutoff =
    opts.maxVectorDistance === undefined
      ? sql``
      : sql` WHERE keyword_hit OR vector_distance <= ${opts.maxVectorDistance}`;
  return sql`
    WITH vector_hits AS (${vectorBranchSql(f, vectorLiteral)}),
    vector_ranked AS (
      SELECT id, distance, ROW_NUMBER() OVER (ORDER BY distance, id) AS rank_v FROM vector_hits
    ),
    fts_hits AS (${ftsBranchSql(f, queryText)}),
    fts_ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY score DESC, id) AS rank_f FROM fts_hits
    ),
    rrf AS (
      SELECT
        COALESCE(v.id, ft.id) AS chunk_id,
        COALESCE(1.0 / (${RRF_K} + v.rank_v), 0.0) + COALESCE(1.0 / (${RRF_K} + ft.rank_f), 0.0) AS rrf_score,
        v.distance::float8 AS vector_distance,
        (ft.id IS NOT NULL) AS keyword_hit
      FROM vector_ranked v
      FULL OUTER JOIN fts_ranked ft ON v.id = ft.id
    ),
    kept AS (SELECT * FROM rrf${cutoff}),
    top AS (${topOf(f, sql`kept`, limit, opts.maxPerDocument)})
    ${passagesFrom(f)}
  `;
}

/**
 * The keyword branch alone, ranked by ts_rank_cd: for when the query cannot be embedded. Scores are the
 * branch's reciprocal-rank share (1 / (60 + rank)) so they read like hybrid scores; no vector distance.
 */
export function keywordSearchSql(
  f: ChunkFilter,
  queryText: string,
  limit: number,
  opts: Pick<SearchOptions, 'maxPerDocument'> = {}
): SQL {
  return sql`
    WITH fts_hits AS (${ftsBranchSql(f, queryText)}),
    ranked AS (
      SELECT id AS chunk_id,
        1.0 / (${RRF_K} + ROW_NUMBER() OVER (ORDER BY score DESC, id)) AS rrf_score,
        NULL::float8 AS vector_distance
      FROM fts_hits
    ),
    top AS (${topOf(f, sql`ranked`, limit, opts.maxPerDocument)})
    ${passagesFrom(f)}
  `;
}

/** How a passage (or a collection row) is cited: `{title} (v{n}, updated {YYYY-MM-DD})`. */
export function citeAs(title: string, number: number, updatedDate: string): string {
  return `${title} (v${number}, updated ${updatedDate})`;
}

function toPassage(r: any): SearchPassage {
  return {
    chunkId: r.chunk_id,
    documentId: r.document_id,
    versionId: r.version_id,
    versionNumber: Number(r.version_number),
    versionTitle: r.version_title,
    spaceId: r.space_id,
    icon: r.icon,
    text: r.text,
    headingPath: r.heading_path,
    blockIds: r.block_ids,
    documentKind: r.document_kind,
    pageFrom: r.page_from === null ? null : Number(r.page_from),
    pageTo: r.page_to === null ? null : Number(r.page_to),
    citeAs: citeAs(r.version_title, r.version_number, r.updated_date),
    rrfScore: Number(r.rrf_score),
    vectorDistance: r.vector_distance === null || r.vector_distance === undefined ? null : Number(r.vector_distance),
  };
}

export async function searchWiki(
  tx: DbTransaction,
  actor: Actor,
  readableSpaceIds: string[],
  inboxSpaceId: string,
  queryText: string,
  queryEmbedding: number[],
  limit = 10,
  embeddingModel?: string,
  opts: SearchOptions = {}
): Promise<SearchPassage[]> {
  if (readableSpaceIds.length === 0) return [];

  const filter = { ...chunkFilterFor(actor, readableSpaceIds, inboxSpaceId), ...(embeddingModel !== undefined ? { embeddingModel } : {}) };
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  // Enable pgvector 0.8 iterative index scans so filtered queries do not under-return rows
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);

  const rows = await tx.execute(searchSql(filter, queryText, vectorLiteral, limit, opts));
  return rowsOf<any>(rows).map(toPassage);
}

/** Keyword-only search with the same permissions and output as `searchWiki` (`vectorDistance` is null). */
export async function keywordSearchWiki(
  tx: DbTransaction,
  actor: Actor,
  readableSpaceIds: string[],
  inboxSpaceId: string,
  queryText: string,
  limit: number,
  opts: Pick<SearchOptions, 'maxPerDocument'> = {}
): Promise<SearchPassage[]> {
  if (readableSpaceIds.length === 0) return [];
  const filter = chunkFilterFor(actor, readableSpaceIds, inboxSpaceId);
  const rows = await tx.execute(keywordSearchSql(filter, queryText, limit, opts));
  return rowsOf<any>(rows).map(toPassage);
}
