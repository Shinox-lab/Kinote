ALTER TABLE "chunks" ALTER COLUMN "embedding" SET DATA TYPE halfvec(2560);--> statement-breakpoint
ALTER TABLE "embedding_cache" ALTER COLUMN "embedding" SET DATA TYPE halfvec(2560);