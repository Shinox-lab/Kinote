-- Plans, usage and quotas (docs/superpowers/specs/2026-11-03-plans-usage-quotas-design.md).
-- Hand-written: 0038/0039 have no drizzle-kit snapshot, so the RLS statements below
-- follow packages/db/scripts/gen-rls.mjs's output format by hand.
CREATE TABLE "tenant_limits" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."tenants"("id"),
  "seats" integer CHECK ("seats" >= 0),
  "storage_bytes" bigint CHECK ("storage_bytes" >= 0),
  "credits_per_month" integer CHECK ("credits_per_month" >= 0),
  "index_credits_per_month" integer CHECK ("index_credits_per_month" >= 0),
  "grace_percent" integer DEFAULT 10 NOT NULL CHECK ("grace_percent" BETWEEN 0 AND 100),
  "period_anchor_day" integer DEFAULT 1 NOT NULL CHECK ("period_anchor_day" BETWEEN 1 AND 28),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text DEFAULT 'control_plane' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id"),
  "period" date NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('capture', 'ask', 'index')),
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "estimated" boolean DEFAULT false NOT NULL,
  "millicredits" bigint NOT NULL,
  "principal_id" uuid,
  "document_id" uuid
);
--> statement-breakpoint
CREATE INDEX "usage_events_tenant_at_idx" ON "usage_events" USING btree ("tenant_id", "at");
--> statement-breakpoint
CREATE TABLE "tenant_usage" (
  "tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id"),
  "period" date NOT NULL,
  "credits_used_milli" bigint DEFAULT 0 NOT NULL,
  "index_credits_used_milli" bigint DEFAULT 0 NOT NULL,
  "credits_topup" integer DEFAULT 0 NOT NULL,
  "warned_80_at" timestamp with time zone,
  "warned_100_at" timestamp with time zone,
  PRIMARY KEY ("tenant_id", "period")
);
--> statement-breakpoint
CREATE TABLE "credit_topups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "public"."tenants"("id"),
  "period" date NOT NULL,
  "credits" integer NOT NULL CHECK ("credits" > 0),
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_topups_tenant_key_idx" ON "credit_topups" USING btree ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE TABLE "tenant_storage" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."tenants"("id"),
  "bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- One-time backfill from stored file versions. Runs before RLS is turned on for
-- tenant_storage: FORCE ROW LEVEL SECURITY binds the migration owner too.
INSERT INTO public.tenant_storage (tenant_id, bytes)
  SELECT tenant_id, sum(size_bytes) FROM public.versions WHERE size_bytes IS NOT NULL GROUP BY tenant_id;
--> statement-breakpoint
-- Keeps tenant_storage in step with file versions. SECURITY DEFINER so a version
-- removed outside a tenant transaction (a purge, a cascade) is still uncounted.
CREATE OR REPLACE FUNCTION public.versions_storage_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.tenant_storage AS s (tenant_id, bytes) VALUES (NEW.tenant_id, NEW.size_bytes)
      ON CONFLICT (tenant_id) DO UPDATE SET bytes = s.bytes + EXCLUDED.bytes;
    RETURN NEW;
  END IF;
  UPDATE public.tenant_storage SET bytes = greatest(0, bytes - OLD.size_bytes) WHERE tenant_id = OLD.tenant_id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.versions_storage_count() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER versions_storage_count_insert AFTER INSERT ON public.versions
  FOR EACH ROW WHEN (NEW.size_bytes IS NOT NULL) EXECUTE FUNCTION public.versions_storage_count();
--> statement-breakpoint
CREATE TRIGGER versions_storage_count_delete AFTER DELETE ON public.versions
  FOR EACH ROW WHEN (OLD.size_bytes IS NOT NULL) EXECUTE FUNCTION public.versions_storage_count();
--> statement-breakpoint
-- Control-plane reads across tenants (the my_tenants pattern): SECURITY DEFINER,
-- pinned search_path, schema-qualified names. Only the internal API calls them.
-- Seats = memberships plus unexpired, unaccepted invitations, both not viewers.
CREATE OR REPLACE FUNCTION public.cp_list_tenants(p_after uuid, p_limit int)
RETURNS TABLE (id uuid, slug text, name text, plan text, created_at timestamptz, deleted_at timestamptz, owner_email text, seats int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.slug, t.name, t.plan, t.created_at, t.deleted_at,
    (SELECT u.email FROM public.memberships m JOIN public.users u ON u.id = m.user_id
       WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at, m.user_id LIMIT 1),
    ((SELECT count(*) FROM public.memberships m WHERE m.tenant_id = t.id AND m.role <> 'viewer')
      + (SELECT count(*) FROM public.invitations i WHERE i.tenant_id = t.id AND i.role <> 'viewer'
           AND i.accepted_at IS NULL AND i.expires_at > now()))::int
  FROM public.tenants t
  WHERE p_after IS NULL
     OR (t.created_at, t.id) > (SELECT a.created_at, a.id FROM public.tenants a WHERE a.id = p_after)
  ORDER BY t.created_at, t.id
  LIMIT p_limit;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cp_list_tenants(uuid, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.cp_list_tenants(uuid, int) TO kinote_app;
--> statement-breakpoint
ALTER TABLE public.tenant_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenant_limits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.tenant_limits
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
--> statement-breakpoint
ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.usage_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.usage_events
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
--> statement-breakpoint
ALTER TABLE public.tenant_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenant_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.tenant_usage
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
--> statement-breakpoint
ALTER TABLE public.credit_topups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.credit_topups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.credit_topups
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
--> statement-breakpoint
ALTER TABLE public.tenant_storage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenant_storage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation_policy ON public.tenant_storage
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());
