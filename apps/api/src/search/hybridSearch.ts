import { sql } from 'drizzle-orm';
import type { DbTransaction } from '@living-wiki/db';
import type { Actor } from '@living-wiki/core';

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

  const isTenantAdmin =
    actor.principalType === 'user' &&
    (actor.tenantRole === 'owner' || actor.tenantRole === 'admin');

  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  // Enable pgvector 0.8 iterative index scans so filtered queries do not under-return rows
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);

  const rows = await tx.execute(sql`
    WITH accessible_chunks AS (
      SELECT
        c.id,
        c.document_id,
        c.version_id,
        c.text,
        c.heading_path,
        c.block_ids,
        c.embedding,
        c.tsv,
        v.title AS version_title,
        v.number AS version_number,
        v.created_at AS version_date
      FROM chunks c
      JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
      JOIN versions v ON v.id = c.version_id AND v.tenant_id = c.tenant_id
      WHERE c.tenant_id = NULLIF(${actor.tenantId}, '')::uuid
        AND c.space_id = ANY(${sql.param(readableSpaceIds)}::uuid[])
        AND (
          c.space_id != ${inboxSpaceId}::uuid
          OR ${isTenantAdmin} = true
          OR (d.created_by_type = ${actor.principalType} AND d.created_by = NULLIF(${actor.principalId}, '')::uuid)
        )
    ),
    vector_ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vectorLiteral}::halfvec) AS rank_v
      FROM accessible_chunks
      ORDER BY embedding <=> ${vectorLiteral}::halfvec
      LIMIT 40
    ),
    fts_ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsv, websearch_to_tsquery('simple', ${queryText})) DESC) AS rank_f
      FROM accessible_chunks
      WHERE tsv @@ websearch_to_tsquery('simple', ${queryText})
      LIMIT 40
    ),
    rrf AS (
      SELECT
        COALESCE(v.id, f.id) AS chunk_id,
        COALESCE(1.0 / (60 + v.rank_v), 0.0) + COALESCE(1.0 / (60 + f.rank_f), 0.0) AS rrf_score
      FROM vector_ranked v
      FULL OUTER JOIN fts_ranked f ON v.id = f.id
    )
    SELECT
      ac.id AS chunk_id,
      ac.document_id,
      ac.version_id,
      ac.text,
      ac.heading_path,
      ac.block_ids,
      ac.version_title,
      ac.version_number,
      to_char(ac.version_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS updated_date,
      rrf.rrf_score
    FROM rrf
    JOIN accessible_chunks ac ON ac.id = rrf.chunk_id
    ORDER BY rrf.rrf_score DESC
    LIMIT ${limit};
  `);

  return rows.rows.map((r: any) => ({
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
