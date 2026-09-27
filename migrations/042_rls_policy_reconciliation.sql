-- Migration 042: reconcile production's RLS policies with what migrations/ creates.
--
-- Pre-C-4b step. A rebuild from migrations/ produced 64 policies; production held 81.
-- Every one of the 64 existed in production with a byte-identical predicate — there is
-- no divergence, only 17 objects that exist in production and in no migration file.
-- Comparison method: rebuild into an empty database, then compare
-- md5(tablename|policyname|cmd|roles|qual|with_check) row for row. Both directions.
--
-- CI could not see this. `tenantIsolation.db.test.ts` asserts that every public table
-- has RLS *enabled*, which was true on both sides throughout. The guard was real and
-- measured the wrong property — it can tell you a table is protected, never that the
-- protection in the database is the protection in the repo.
--
-- This migration changes production in exactly two ways, and neither alters any
-- caller's access. Enumerated one at a time, because a migration header that reasons
-- about its operations in aggregate is how 036 silenced every notification:
--
-- 1. CREATE POLICY service_role_bypass on 16 tables (001-era). Permissive, scoped
--    TO service_role. A permissive policy can only widen access, and only for the role
--    it names — no other role is affected. service_role additionally holds the
--    BYPASSRLS attribute in production (verified: pg_roles.rolbypassrls = true), so it
--    is inert there today as well. It stops being inert under C-4b, which replaces
--    BYPASSRLS with per-table permissive policies; that is the reason to codify these
--    rather than drop them.
--
-- 2. DROP POLICY "Users can read own notifications" on notifications. Created by hand
--    in the Supabase dashboard; in no migration file. It is SELECT, TO authenticated,
--    USING (user_id = auth.uid()) — strictly a subset of notifications_user from
--    020_rls_policies.sql, which is FOR ALL, TO public (which includes authenticated),
--    on the identical predicate. Both are PERMISSIVE, so the surviving policy grants
--    everything the dropped one did; nothing loses access. No web code reads Supabase
--    tables directly (zero `supabase.from(...)` call sites in apps/web), so nothing
--    depends on it by name either.
--
-- After this migration a rebuild and production both hold 80 policies with identical
-- predicates. scripts/sql/rls_drift_check.sql re-runs the comparison against any
-- database; scripts/sql/rls_policy_inventory.txt is the expected set, and
-- rlsPolicyDrift.db.test.ts pins the migration side of it.
--
-- Not done here, deliberately: six platform tables (onboarding_sessions,
-- platform_announcements, platform_audit_logs, platform_metrics_snapshots,
-- platform_subscriptions, support_sessions) have no service_role_bypass in production
-- OR in migrations. They agree, so they are not drift, and giving them one would be a
-- change to production's access surface wearing a reconciliation's clothes.

BEGIN;

-- 1. The 16 tables created by 001, before service_role_bypass was the convention.
--    WITH CHECK (true) matches what production holds; the 020/031-era policies have
--    no WITH CHECK, and this migration does not change either group to match the other.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'academic_sessions', 'assessment_components', 'assessment_configs', 'audit_logs',
    'classes', 'parent_students', 'result_status', 'school_settings', 'schools',
    'scores', 'student_classes', 'students', 'subjects', 'teacher_assignments',
    'terms', 'users'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS service_role_bypass ON %I', t);
    EXECUTE format(
      'CREATE POLICY service_role_bypass ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t);
  END LOOP;
END $$;

-- 2. The one policy that exists in production and in no file.
DROP POLICY IF EXISTS "Users can read own notifications" ON notifications;

COMMIT;
