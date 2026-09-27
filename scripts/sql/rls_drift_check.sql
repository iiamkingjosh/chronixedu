-- Does this database's RLS policy set match what migrations/ creates?
--
-- Run against a DEPLOYED database (production, staging) — read-only, no writes, no DDL.
-- The migration side is pinned by rlsPolicyDrift.db.test.ts in CI; this is the other
-- half, and it is the only half that can see a policy created by hand in the Supabase
-- dashboard. One such policy existed for an unknown period before 042 removed it, and
-- CI never went red, because the only RLS assertion it carried was "enabled = true".
--
-- Usage:
--   1. Paste the contents of scripts/sql/rls_policy_inventory.txt (skipping the # header
--      lines) into the `expected` VALUES list below, one quoted line each.
--   2. Run the whole file.
--   3. An empty result is a match. Any row is drift:
--        ONLY_IN_DATABASE   — exists here, in no migration. Drop it, or codify it in a
--                             migration. Either way, deliberately.
--        ONLY_IN_MIGRATIONS — a migration creates it and this database does not have it.
--                             Usually means a migration has not been applied here:
--                             check `SELECT * FROM migration_runs ORDER BY id DESC LIMIT 5`.
--
-- A policy whose PREDICATE changed shows up as one row of each kind, not as a silent
-- match — the compared signature includes qual and with_check, not just the name.

WITH actual AS (
  SELECT tablename || '|' || policyname || '|' || cmd || '|'
         || coalesce(array_to_string(roles, ','), '')
         || '|Q=' || coalesce(regexp_replace(qual, '\s+', ' ', 'g'), '-')
         || '|C=' || coalesce(regexp_replace(with_check, '\s+', ' ', 'g'), '-') AS sig
    FROM pg_policies
   WHERE schemaname = 'public'
),
expected AS (
  SELECT unnest(ARRAY[
    -- ── paste scripts/sql/rls_policy_inventory.txt here, one quoted line each ──
    ''
  ]) AS sig
)
SELECT 'ONLY_IN_DATABASE' AS side, sig FROM actual
 WHERE sig NOT IN (SELECT sig FROM expected)
UNION ALL
SELECT 'ONLY_IN_MIGRATIONS', sig FROM expected
 WHERE sig <> '' AND sig NOT IN (SELECT sig FROM actual)
 ORDER BY 1, 2;
