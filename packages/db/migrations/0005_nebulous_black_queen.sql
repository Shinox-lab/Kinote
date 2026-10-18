DROP INDEX "invitations_tenant_email_idx";--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_tenant_email_idx" ON "invitations" USING btree ("tenant_id","email") WHERE "invitations"."accepted_at" is null;