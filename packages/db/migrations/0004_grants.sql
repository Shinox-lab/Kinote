-- Custom SQL migration: application role privileges.
--
-- The api/collab/worker services run as living_wiki_app so the RLS policies in
-- 0002_rls apply. The role is created here only if absent and WITHOUT login or
-- password: in deployed environments infra/postgres/01-roles.sh creates it
-- first as a LOGIN role with its password taken from $APP_DB_PASSWORD.
-- It is never a superuser and never BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'living_wiki_app') THEN
    CREATE ROLE living_wiki_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO living_wiki_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO living_wiki_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO living_wiki_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.my_tenants(uuid) TO living_wiki_app;
