CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"name_embedding" halfvec(2560) NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"chunk_id" uuid,
	"space_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_extraction_cache" (
	"tenant_id" uuid NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_mentions" (
	"tenant_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"chunk_id" uuid,
	"space_id" uuid NOT NULL,
	"block_ids" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_cards" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"outline" text[] NOT NULL,
	"embedding" halfvec(2560) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_from_entity_id_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_to_entity_id_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_edges" ADD CONSTRAINT "entity_edges_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_extraction_cache" ADD CONSTRAINT "entity_extraction_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_cards" ADD CONSTRAINT "page_cards_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_cards" ADD CONSTRAINT "page_cards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_cards" ADD CONSTRAINT "page_cards_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_cards" ADD CONSTRAINT "page_cards_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_tenant_kind_name_idx" ON "entities" USING btree ("tenant_id","kind","normalized_name");--> statement-breakpoint
CREATE INDEX "entities_name_trgm_idx" ON "entities" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entity_edges_from_idx" ON "entity_edges" USING btree ("tenant_id","from_entity_id");--> statement-breakpoint
CREATE INDEX "entity_edges_to_idx" ON "entity_edges" USING btree ("tenant_id","to_entity_id");--> statement-breakpoint
CREATE INDEX "entity_edges_document_idx" ON "entity_edges" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_extraction_cache_lookup_idx" ON "entity_extraction_cache" USING btree ("tenant_id","model","content_hash");--> statement-breakpoint
CREATE INDEX "entity_mentions_entity_idx" ON "entity_mentions" USING btree ("tenant_id","entity_id");--> statement-breakpoint
CREATE INDEX "entity_mentions_document_idx" ON "entity_mentions" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "page_cards_tenant_space_idx" ON "page_cards" USING btree ("tenant_id","space_id");--> statement-breakpoint
CREATE INDEX "page_cards_embedding_hnsw_idx" ON "page_cards" USING hnsw ("embedding" halfvec_cosine_ops);