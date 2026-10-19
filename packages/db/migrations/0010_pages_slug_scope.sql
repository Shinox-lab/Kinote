DROP INDEX "pages_space_slug_idx";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "slug_scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Existing Inbox pages: slugs become unique per creator (pageSlugScope in @living-wiki/core).
UPDATE "pages" AS p SET "slug_scope" = d."created_by_type" || ':' || d."created_by"
FROM "documents" AS d, "spaces" AS s
WHERE d."id" = p."document_id" AND d."tenant_id" = p."tenant_id"
  AND s."id" = p."space_id" AND s."tenant_id" = p."tenant_id" AND s."kind" = 'inbox';--> statement-breakpoint
CREATE UNIQUE INDEX "pages_space_slug_idx" ON "pages" USING btree ("tenant_id","space_id","slug_scope","slug");
