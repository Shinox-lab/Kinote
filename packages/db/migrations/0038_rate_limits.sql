-- Counters for rate limits and budgets, shared by every api and worker process
-- (one process's memory is not enough once several api copies run). Global
-- like users and sessions: no tenant_id and no RLS; the keys say whose count
-- it is. kinote_app gets SELECT/INSERT/UPDATE/DELETE from the default
-- privileges in 0004_grants.sql.
CREATE TABLE "rate_limit_counters" (
  "key" text PRIMARY KEY NOT NULL,
  "count" integer NOT NULL,
  "reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_counters_reset_at_idx" ON "rate_limit_counters" USING btree ("reset_at");
