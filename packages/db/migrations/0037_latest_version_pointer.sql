-- The tree reads each document's latest version through documents.latest_version_id
-- instead of a per-document max(versions.number) subquery. Production snapshot
-- writes already maintain that pointer; this backfills rows written before it
-- was reliably set.
UPDATE "documents" AS d
SET "latest_version_id" = latest."id"
FROM (
  SELECT DISTINCT ON (v."tenant_id", v."document_id")
    v."tenant_id",
    v."document_id",
    v."id"
  FROM "versions" AS v
  ORDER BY v."tenant_id", v."document_id", v."number" DESC
) AS latest
WHERE d."tenant_id" = latest."tenant_id"
  AND d."id" = latest."document_id"
  AND d."latest_version_id" IS DISTINCT FROM latest."id";
