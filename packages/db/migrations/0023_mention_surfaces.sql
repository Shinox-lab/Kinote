ALTER TABLE "entity_mentions" ADD COLUMN "surfaces" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD COLUMN "surface_keys" text[] DEFAULT '{}' NOT NULL;