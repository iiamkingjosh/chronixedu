-- ═══════════════════════════════════════════════════════════════════════════════════
-- C-4a PROPOSED grant set — NOT APPLIED ANYWHERE BUT A LOCAL REBUILD. For the second read.
-- ═══════════════════════════════════════════════════════════════════════════════════
--
-- Check this against docs/c4a/operations.md (what the code does) and
-- docs/c4a/routes.md (what can reach it), not against this header's description of it.
-- The executable form of "is this right" is scripts/sql/c4a_boundary_check.sql, which
-- scripts/c4a/probe.js runs after applying this file.
--
-- Two roles, created out of band as LOGIN with a password — which must never live in the
-- repo. When this becomes a migration, the migration creates them NOLOGIN (IF NOT EXISTS)
-- and the cutover runs `ALTER ROLE … LOGIN PASSWORD …` by hand.
--   chronixedu_app    the pool: every authenticated route, the workers, the crons
--   chronixedu_login  POST /login only — the one path that reaches the database on behalf
--                     of an UNAUTHENTICATED caller. If a flaw there shared the app role it
--                     would reach scores, payments and audit rows; with this role it
--                     reaches ten user columns and one schools column.
--
-- Revision 2, after the second read:
--   * Owner-only and append-only tables are identified by a PROPERTY (their table
--     comment), not a hardcoded list, so the policy loop and the boundary check cannot
--     disagree with each other about which tables they are.
--   * The login connection has its own column-scoped role.
--   * Nothing here makes a future table safe by itself. ALTER DEFAULT PRIVILEGES gives a
--     new table DML; only its migration can give it a policy. The boundary check is what
--     turns a forgotten policy from "the app reads zero rows, silently" into a failure
--     that names the table.

-- ── Classification, by property ──────────────────────────────────────────────────────
COMMENT ON TABLE schema_migrations IS
  'owner-only: migration bookkeeping. Written by the pre-deploy migrate step, as owner. No application role may hold any privilege on it.';
COMMENT ON TABLE migration_runs IS
  'owner-only: proof the pre-deploy migrate gate ran. Written as owner. No application role may hold any privilege on it.';
COMMENT ON TABLE audit_logs IS
  'append-only: the app may SELECT and INSERT, and UPDATE only processed_at (the notification queue marker, migration 037). Never DELETE. Enforced by privilege here and by the 036-038 triggers.';

-- ── chronixedu_app ──────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO chronixedu_app;

-- DML only. ALL would include TRUNCATE, REFERENCES and TRIGGER, which no application code
-- issues (operations.md), so they are never granted rather than granted and revoked.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chronixedu_app;

-- Owner-only tables: everything revoked, found by their comment.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
              AND obj_description(c.oid, 'pg_class') LIKE 'owner-only:%'
  LOOP
    EXECUTE format('REVOKE ALL ON %I FROM chronixedu_app', t);
  END LOOP;
END $$;

-- audit_logs: UPDATE is revoked and re-granted on the one column the notification worker
-- writes. "No UPDATE on audit_logs" applied literally would be migration 036 again.
REVOKE UPDATE, DELETE ON audit_logs FROM chronixedu_app;
GRANT UPDATE (processed_at) ON audit_logs TO chronixedu_app;

-- New tables are born with DML. A new owner-only table must be marked and revoked by its
-- migration; the boundary check fails until it is.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chronixedu_app;

-- One permissive policy per non-owner-only table, until C-4b replaces each with a real one.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r'
              AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT LIKE 'owner-only:%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'app_bypass_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO chronixedu_app USING (true) WITH CHECK (true)',
      'app_bypass_' || t, t);
  END LOOP;
END $$;

-- ── chronixedu_login ────────────────────────────────────────────────────────────────
-- Exactly what POST /login issues (routes/auth.ts), column by column. Notably NOT
-- password_hash: login verifies passwords through Supabase Auth, so the role that serves
-- unauthenticated callers cannot read a single hash.
GRANT USAGE ON SCHEMA public TO chronixedu_login;
GRANT SELECT (id, school_id, role, title, email, first_name, last_name, is_active, support_code, must_change_password)
  ON users TO chronixedu_login;
GRANT UPDATE (last_login_at) ON users TO chronixedu_login;
GRANT SELECT (id, subscription_tier) ON schools TO chronixedu_login;

DROP POLICY IF EXISTS login_read_users ON users;
CREATE POLICY login_read_users ON users FOR SELECT TO chronixedu_login USING (true);
DROP POLICY IF EXISTS login_stamp_users ON users;
CREATE POLICY login_stamp_users ON users FOR UPDATE TO chronixedu_login USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS login_read_schools ON schools;
CREATE POLICY login_read_schools ON schools FOR SELECT TO chronixedu_login USING (true);

-- Sequences: none. The only sequence in public is migration_runs_id_seq (owner-only).
-- Functions: none. App SQL calls only pgcrypto built-ins, executable by PUBLIC.
-- NB: landing this changes the RLS policy set, so scripts/sql/rls_policy_inventory.txt
-- is regenerated in the same migration.
