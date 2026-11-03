-- Email verification and password reset by email (both only when SMTP is set).
-- Accounts that exist before this migration count as verified, so nobody
-- already using Kinote is locked out of accepting invitations.
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "users" SET "email_verified_at" = now() WHERE "password_hash" <> '!';
--> statement-breakpoint
-- One-time links sent by email: `verify` (24 h) and `reset` (1 h). Global like
-- users and sessions (no tenant_id, no RLS); only the SHA-256 of the token is kept.
CREATE TABLE "email_tokens" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL CHECK ("purpose" IN ('verify', 'reset')),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "email_tokens_user_idx" ON "email_tokens" USING btree ("user_id");
