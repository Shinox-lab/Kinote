ALTER TABLE "jobs" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "rerun_requested" boolean DEFAULT false NOT NULL;