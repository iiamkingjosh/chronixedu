-- ═══════════════════════════════════════════════════════════════════════════════════
-- C-4a PROPOSED grant set — NOT APPLIED ANYWHERE BUT A LOCAL REBUILD. For the second read.
-- ═══════════════════════════════════════════════════════════════════════════════════
--
-- Check this against docs/c4a/operations.md (what the code does) and
-- docs/c4a/routes.md (what can reach it), not against this header's description of it.
-- docs/c4a/crosscheck.md is one reader's mechanical diff of the two; it is a starting
-- point for the second read, not a substitute for it.
--
-- The role itself is created out of band — its password must never live in the repo:
--   CREATE ROLE chronixedu_app LOGIN PASSWORD '<secret>' NOINHERIT;
-- (Local probing uses a NOLOGIN role of the same name; see scripts/c4a/probe.sh.)
--
-- Deliberate departure from the plan's wording ("GRANT broadly, then REVOKE by
-- operation"): only DML is granted. ALL would include TRUNCATE, REFERENCES and TRIGGER,
-- which no application code issues (operations.md: TRUNCATE appears nowhere outside the
-- test harness), so they are never granted rather than granted and revoked. Every REVOKE
-- that remains below was probed to change an outcome on this exact grant set — see
-- probe.md. A REVOKE that revokes nothing reads like a guarantee and is not one.

GRANT USAGE ON SCHEMA public TO chronixedu_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chronixedu_app;

-- Migration bookkeeping is the owner's. The pre-deploy migrate step connects as owner
-- (DATABASE_URL); nothing on the app pool reads or writes these (operations.md: their
-- only references are in src/scripts/migrate.ts, owner connection).
REVOKE ALL ON schema_migrations, migration_runs FROM chronixedu_app;

-- audit_logs is append-only for the app — at the privilege layer now, not only by the
-- 036/037 triggers. INSERT and SELECT remain. UPDATE is NOT revoked wholesale: the
-- notification worker marks rows processed (notificationWorker.ts), which is the exact
-- path migration 036 broke by forbidding UPDATE without checking who issued one. So
-- UPDATE is revoked and re-granted on the single column the worker writes. The plan's
-- text said "no DELETE/UPDATE on audit_logs"; applied literally, it would have been 036
-- again, one layer down.
REVOKE UPDATE, DELETE ON audit_logs FROM chronixedu_app;
GRANT UPDATE (processed_at) ON audit_logs TO chronixedu_app;

-- Tables created by later migrations must be born inside the boundary, or the deploy
-- after the next migration fails with `permission denied` on its new table. Scoped to
-- the role that runs migrations (the table owner).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chronixedu_app;

-- Step 3 of the plan: RLS switches on for every table the moment the app stops being the
-- owner, and all 42 tenant policies are inert (auth.jwt() is NULL on a direct pg
-- connection). One named permissive policy per table keeps them readable until C-4b
-- replaces each with a real one. `app_bypass_%` is the enumerable backlog.
-- NB: landing these changes the RLS policy set, so scripts/sql/rls_policy_inventory.txt
-- must be regenerated in the same migration or rlsPolicyDrift.db.test.ts fails.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename NOT IN ('schema_migrations', 'migration_runs')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'app_bypass_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO chronixedu_app USING (true) WITH CHECK (true)',
      'app_bypass_' || t, t);
  END LOOP;
END $$;

-- Sequences: none. The only sequence in public is migration_runs_id_seq (owner). Every
-- table the app writes keys on gen_random_uuid().
-- Functions: none. App SQL calls only pgcrypto built-ins, executable by PUBLIC.
