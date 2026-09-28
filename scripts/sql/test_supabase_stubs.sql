-- Minimal stand-ins for the Supabase-provided objects the migrations reference.
-- ONLY for disposable local/CI test databases. Never run against Supabase.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
-- Bodies copied VERBATIM from production (pg_proc, 28 Sep 2026). Not "equivalent": these
-- are LANGUAGE sql STABLE, so the planner inlines them by re-parsing the body as the
-- CURRENT role. The previous stub's auth.uid() called auth.jwt() by schema-qualified
-- name, so any role without USAGE on schema auth failed to plan a query touching a
-- policy that uses auth.uid() — "permission denied for schema auth" — while production's
-- bodies name only current_setting() and cannot fail that way. The C-4a probe was
-- measuring the stub, not the system. Keep these identical to production.
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ select coalesce( nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), '') )::jsonb $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ select coalesce( nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub') )::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ select coalesce( nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') )::text $$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS
  $$ select coalesce( nullif(current_setting('request.jwt.claim.email', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email') )::text $$;
-- Production grants USAGE on schema auth to anon, authenticated, service_role and
-- postgres — NOT to PUBLIC — and EXECUTE on these functions to PUBLIC. Mirrored, so a
-- new role (chronixedu_app, chronixedu_login) sees exactly what it would see there.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email() TO PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Mirror Supabase's default grants so RLS tests are meaningful.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
