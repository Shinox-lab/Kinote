-- A file's published version is what readers below editor may open: the indexed version, or a version with
-- no text (an image without words, audio, video) once it needs no review or is approved. Hand-written.
ALTER TABLE "documents" ADD COLUMN "published_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "no_text" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "versions" SET "no_text" = true WHERE "status" = 'stored';
--> statement-breakpoint
UPDATE "documents" SET "published_version_id" = "indexed_version_id" WHERE "kind" = 'file';
--> statement-breakpoint
UPDATE "documents" d SET "published_version_id" = s."id"
FROM (
  SELECT DISTINCT ON (v."document_id") v."id", v."document_id", v."number"
  FROM "versions" v WHERE v."status" = 'stored' ORDER BY v."document_id", v."number" DESC
) s
LEFT JOIN "versions" iv ON iv."id" = (SELECT "indexed_version_id" FROM "documents" WHERE "id" = s."document_id")
WHERE d."id" = s."document_id" AND d."kind" = 'file' AND d."archived_at" IS NULL
  AND s."number" > COALESCE(iv."number", 0);
