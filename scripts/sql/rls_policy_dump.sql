-- Canonical dump of the public schema's RLS policies, one line per policy.
-- Used to (re)generate scripts/sql/rls_policy_inventory.txt after a policy change,
-- and by rls_drift_check.sql to read the same shape from a deployed database.
SELECT tablename || '|' || policyname || '|' || cmd || '|'
       || coalesce(array_to_string(roles, ','), '')
       || '|Q=' || coalesce(regexp_replace(qual, '\s+', ' ', 'g'), '-')
       || '|C=' || coalesce(regexp_replace(with_check, '\s+', ' ', 'g'), '-')
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename, policyname;
