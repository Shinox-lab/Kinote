CREATE TABLE "capture_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"op" text NOT NULL,
	"before_markdown" text,
	"after_markdown" text NOT NULL,
	"version_id" uuid,
	"status" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"statement" text NOT NULL,
	"kind" text NOT NULL,
	"names" text[] DEFAULT '{}' NOT NULL,
	"date" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"confidence" real,
	"reason" text,
	"waiting_question_id" uuid,
	"pinned_entity_ids" uuid[] DEFAULT '{}' NOT NULL,
	"placed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"options" jsonb,
	"answers_message_id" uuid,
	"choice" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"text" text NOT NULL,
	"source_ref" text,
	"scope_space_id" uuid,
	"scope_page_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_document_id" uuid,
	"source_version_id" uuid,
	"chunk_id" uuid,
	"capture_id" uuid,
	"fact_id" uuid,
	"quote" text NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_examples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"statement_embedding" halfvec(2560) NOT NULL,
	"chosen_document_id" uuid NOT NULL,
	"wrong_document_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_leases" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"block_id" text,
	"after_block_id" text,
	"kind" text NOT NULL,
	"proposed_markdown" text,
	"proposed_blocks" jsonb,
	"reason" text NOT NULL,
	"blocked_by" text NOT NULL,
	"conflict_citation_id" uuid,
	"capture_id" uuid,
	"fact_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" DROP CONSTRAINT "entities_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "capture_changes" ADD CONSTRAINT "capture_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_changes" ADD CONSTRAINT "capture_changes_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_changes" ADD CONSTRAINT "capture_changes_fact_id_capture_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."capture_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_changes" ADD CONSTRAINT "capture_changes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_changes" ADD CONSTRAINT "capture_changes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_changes" ADD CONSTRAINT "capture_changes_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_facts" ADD CONSTRAINT "capture_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_facts" ADD CONSTRAINT "capture_facts_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_facts" ADD CONSTRAINT "capture_facts_waiting_question_id_capture_messages_id_fk" FOREIGN KEY ("waiting_question_id") REFERENCES "public"."capture_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_messages" ADD CONSTRAINT "capture_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_messages" ADD CONSTRAINT "capture_messages_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_scope_space_id_spaces_id_fk" FOREIGN KEY ("scope_space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_scope_page_id_documents_id_fk" FOREIGN KEY ("scope_page_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_page_id_documents_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_source_version_id_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citations" ADD CONSTRAINT "citations_fact_id_capture_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."capture_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_examples" ADD CONSTRAINT "routing_examples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_examples" ADD CONSTRAINT "routing_examples_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_examples" ADD CONSTRAINT "routing_examples_chosen_document_id_documents_id_fk" FOREIGN KEY ("chosen_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_examples" ADD CONSTRAINT "routing_examples_wrong_document_id_documents_id_fk" FOREIGN KEY ("wrong_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_leases" ADD CONSTRAINT "routing_leases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_fact_id_capture_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."capture_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capture_changes_capture_idx" ON "capture_changes" USING btree ("tenant_id","capture_id");--> statement-breakpoint
CREATE INDEX "capture_changes_document_idx" ON "capture_changes" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_facts_ordinal_idx" ON "capture_facts" USING btree ("tenant_id","capture_id","ordinal");--> statement-breakpoint
CREATE INDEX "capture_facts_outcome_idx" ON "capture_facts" USING btree ("tenant_id","outcome");--> statement-breakpoint
CREATE INDEX "capture_messages_capture_idx" ON "capture_messages" USING btree ("tenant_id","capture_id","created_at");--> statement-breakpoint
CREATE INDEX "captures_sender_idx" ON "captures" USING btree ("tenant_id","sender_type","sender_id","created_at");--> statement-breakpoint
CREATE INDEX "citations_block_idx" ON "citations" USING btree ("tenant_id","page_id","block_id");--> statement-breakpoint
CREATE INDEX "routing_examples_space_idx" ON "routing_examples" USING btree ("tenant_id","space_id");--> statement-breakpoint
CREATE INDEX "routing_examples_embedding_hnsw_idx" ON "routing_examples" USING hnsw ("statement_embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "suggestions_document_idx" ON "suggestions" USING btree ("tenant_id","document_id","status");--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;