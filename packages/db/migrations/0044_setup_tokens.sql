-- A third kind of one-time email link: `setup`, the first owner's link on a new dedicated instance
-- (POST /internal/v1/bootstrap; Kinote-SaaS docs/superpowers/specs/2026-11-10-dedicated-instances-design.md).
-- It is set through the reset-password page and works for 72 hours. Hand-written, following 0042's format.
ALTER TABLE "email_tokens" DROP CONSTRAINT "email_tokens_purpose_check";
--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_purpose_check" CHECK ("purpose" IN ('verify', 'reset', 'setup'));
