CREATE TABLE "page_pending_contributors" (
	"tenant_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_pending_contributors" ADD CONSTRAINT "page_pending_contributors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_pending_contributors" ADD CONSTRAINT "page_pending_contributors_page_id_documents_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_pending_contributors_unique_idx" ON "page_pending_contributors" USING btree ("tenant_id","page_id","principal_type","principal_id");