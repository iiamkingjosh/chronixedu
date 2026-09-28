-- C-4a boundary check. Every row returned is a violation, named by its consequence.
-- An EMPTY result is a pass — so scripts/c4a/probe.js proves it can return rows (by
-- creating a table the way a future migration would) before trusting an empty one
-- (CLAUDE.md doctrine 16).
--
-- DERIVED, not snapshotted. It enumerates pg_class and asks Postgres what each role
-- holds, so there is no file to regenerate that would bless a missing policy. That is
-- the difference from rls_policy_inventory.txt: when a migration adds a table and forgets
-- its app policy, that test says "inventory out of date" and the reflex remedy is to
-- regenerate the inventory, which blesses the omission. This says "the app would read
-- zero rows from <table>, silently", which cannot be fixed by regenerating anything.
--
-- Each public table is classified by a PROPERTY, its comment — never by a list here:
--   'owner-only: …'   migration bookkeeping. The app must hold NOTHING on it.
--   'append-only: …'  SELECT + INSERT, UPDATE only on processed_at, never DELETE.
--   (anything else)    an application table: full DML plus a permissive policy for the
--                      app role, until C-4b replaces app_bypass_<table> with a real one.
-- ALTER DEFAULT PRIVILEGES hands every new table DML, so a new bookkeeping table is
-- flagged here until its migration marks it owner-only AND revokes — a deliberate act.

WITH auth_eval AS MATERIALIZED (
  -- Property (b) below: evaluated, not inspected. MATERIALIZED so it cannot be optimised
  -- away; if either function raised on an absent setting, the check errors here.
  SELECT auth.uid() AS uid, auth.jwt() AS jwt
),
roles AS (
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chronixedu_app')   AS app_ok,
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chronixedu_login') AS login_ok
),
tbl AS (
  SELECT c.oid, c.relname AS name,
         CASE WHEN obj_description(c.oid, 'pg_class') LIKE 'owner-only:%'  THEN 'owner-only'
              WHEN obj_description(c.oid, 'pg_class') LIKE 'append-only:%' THEN 'append-only'
              ELSE 'app' END AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
),
app AS (
  SELECT t.*,
         has_table_privilege('chronixedu_app', t.oid, 'SELECT')   AS s,
         has_table_privilege('chronixedu_app', t.oid, 'INSERT')   AS i,
         has_table_privilege('chronixedu_app', t.oid, 'UPDATE')   AS u,
         has_table_privilege('chronixedu_app', t.oid, 'DELETE')   AS d,
         has_table_privilege('chronixedu_app', t.oid, 'TRUNCATE') AS tr,
         has_any_column_privilege('chronixedu_app', t.oid, 'SELECT, INSERT, UPDATE, REFERENCES') AS anycol,
         EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = t.name
                    AND p.permissive = 'PERMISSIVE' AND p.cmd = 'ALL'
                    AND 'chronixedu_app' = ANY (p.roles)) AS admitted
    FROM tbl t, roles r
   WHERE r.app_ok
),
login_expected (table_name, column_name, privilege_type) AS (
  -- The login connection's whole requirement, read off routes/auth.ts POST /login.
  -- A deliberate list: this is the specification of one narrow role, not a classification.
  VALUES ('users','id','SELECT'), ('users','school_id','SELECT'), ('users','role','SELECT'),
         ('users','title','SELECT'), ('users','email','SELECT'), ('users','first_name','SELECT'),
         ('users','last_name','SELECT'), ('users','is_active','SELECT'), ('users','support_code','SELECT'),
         ('users','must_change_password','SELECT'), ('users','last_login_at','UPDATE'),
         ('schools','id','SELECT'), ('schools','subscription_tier','SELECT')
),
login_actual AS (
  SELECT table_name::text, column_name::text, privilege_type::text
    FROM information_schema.column_privileges
   WHERE grantee = 'chronixedu_login' AND table_schema = 'public'
)
SELECT 'role chronixedu_app does not exist' AS violation FROM roles WHERE NOT app_ok
UNION ALL
SELECT 'auth.uid()/auth.jwt() returned a value with no request.jwt setting present — they no longer read only the settings C-4a assumes'
  FROM auth_eval WHERE uid IS NOT NULL OR jwt IS NOT NULL
UNION ALL
-- Two properties of Supabase's auth.* functions that C-4a depends on. They fail in
-- different ways, so they are checked in different ways.
--
-- (a) The bodies must not NAME schema auth. These are LANGUAGE sql and get INLINED: the
--     planner re-parses the body as the current role, so a body referring to auth.jwt()
--     needs USAGE on schema auth, which neither of our roles holds. That fails at PLANNING
--     — before permissive policies are OR'd and folded — so a USING (true) policy does not
--     rescue it: measured, the login probes failed with login_read_users in place. Every
--     query under a policy calling the function would fail, for both roles. This is the
--     failure the old local stub produced; its auth.jwt() had missing_ok and never raised.
--
-- (b) The bodies must not RAISE on an absent setting (they use current_setting(…, true)).
--     That would fail at RUNTIME, and a permissive USING (true) for the same command does
--     rescue it, since `true OR f()` is folded away before f() runs. Checked by calling
--     them below with no request.jwt settings present: if one ever raised, this whole
--     check errors — loud, which is the point.
--
-- Both are properties of SQL this project does not own. C-4b removes the dependency:
-- current_setting('app.school_id', true) is our own setting with our own missing_ok flag.
SELECT format('auth.%s() body references schema auth — roles without USAGE on it cannot plan queries under policies that call it', p.proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'auth' AND p.proname IN ('uid', 'jwt', 'role', 'email')
   AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
   AND p.prosrc ~* '\mauth\s*\.'
UNION ALL
SELECT 'role chronixedu_login does not exist' FROM roles WHERE NOT login_ok
UNION ALL
SELECT format('%s: no permissive policy admits chronixedu_app — the app would read zero rows from it, silently', name)
  FROM app WHERE kind IN ('app', 'append-only') AND NOT admitted
UNION ALL
SELECT format('%s: chronixedu_app lacks %s — permission denied on first use', name,
              concat_ws(', ', CASE WHEN NOT s THEN 'SELECT' END, CASE WHEN NOT i THEN 'INSERT' END,
                              CASE WHEN NOT u THEN 'UPDATE' END, CASE WHEN NOT d THEN 'DELETE' END))
  FROM app WHERE kind = 'app' AND NOT (s AND i AND u AND d)
UNION ALL
SELECT format('%s: append-only, but chronixedu_app %s', name,
              concat_ws('; ', CASE WHEN NOT s THEN 'cannot SELECT' END, CASE WHEN NOT i THEN 'cannot INSERT' END,
                              CASE WHEN u THEN 'holds table-level UPDATE' END, CASE WHEN d THEN 'holds DELETE' END,
                              CASE WHEN NOT has_column_privilege('chronixedu_app', oid, 'processed_at', 'UPDATE')
                                   THEN 'cannot UPDATE processed_at (the notification worker would stop)' END))
  FROM app
 WHERE kind = 'append-only'
   AND (NOT s OR NOT i OR u OR d OR NOT has_column_privilege('chronixedu_app', oid, 'processed_at', 'UPDATE'))
UNION ALL
SELECT format('%s: owner-only, but chronixedu_app holds privileges on it — REVOKE ALL in the migration that created it', name)
  FROM app WHERE kind = 'owner-only' AND (s OR i OR u OR d OR tr OR anycol)
UNION ALL
SELECT format('%s: owner-only, but a policy admits chronixedu_app', name)
  FROM app WHERE kind = 'owner-only' AND admitted
UNION ALL
SELECT format('%s: chronixedu_app holds TRUNCATE', name) FROM app WHERE tr
UNION ALL
SELECT format('%s: no policy admits chronixedu_login for %s — every login would find no user', need.tbl, need.cmd)
  FROM (VALUES ('users', 'SELECT'), ('users', 'UPDATE'), ('schools', 'SELECT')) AS need (tbl, cmd), roles r
 WHERE r.login_ok AND NOT EXISTS (SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = need.tbl AND p.permissive = 'PERMISSIVE'
          AND p.cmd IN (need.cmd, 'ALL') AND 'chronixedu_login' = ANY (p.roles))
UNION ALL
SELECT format('chronixedu_login holds %s on %s.%s, which POST /login never uses', a.privilege_type, a.table_name, a.column_name)
  FROM login_actual a, roles r WHERE r.login_ok AND NOT EXISTS (SELECT 1 FROM login_expected e
         WHERE (e.table_name, e.column_name, e.privilege_type) = (a.table_name, a.column_name, a.privilege_type))
UNION ALL
SELECT format('chronixedu_login lacks %s on %s.%s — login fails with permission denied', e.privilege_type, e.table_name, e.column_name)
  FROM login_expected e, roles r WHERE r.login_ok AND NOT EXISTS (SELECT 1 FROM login_actual a
         WHERE (e.table_name, e.column_name, e.privilege_type) = (a.table_name, a.column_name, a.privilege_type))
ORDER BY 1;
