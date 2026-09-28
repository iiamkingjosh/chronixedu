# C-4a privilege probe (generated — `node scripts/c4a/probe.js`)

Run against a **local rebuild** of `migrations/`, as NOLOGIN roles via `SET LOCAL ROLE`,
each probe in its own rolled-back transaction. **Phase B** is `grants.sql` as proposed;
**Phase A** the same with its REVOKEs undone. Production is PG 17.6, this rebuild PG 16 —
none of the semantics probed changed between them, but the plan requires re-running this
against the real roles before cutover.

**38 of 38 probe expectations held; 8 of 8 boundary-check expectations held.** 42 `app_bypass_*` policies for 44 tables (the owner-only ones excluded, by their comment).

## Privilege probes

| Role | Probe | A: without REVOKEs | B: as proposed | Does a REVOKE change it? | Why |
|---|---|---|---|---|---|
| app | TRUNCATE a tenant table | ✅ denied — permission denied for table notices | ✅ denied — permission denied for table notices | no | Never granted — DML only. Absent by construction; no REVOKE written. |
| app | CREATE TABLE in public | ✅ denied — permission denied for schema public | ✅ denied — permission denied for schema public | no | PG15+ gives PUBLIC no CREATE on public, and USAGE is not CREATE. No REVOKE needed; none written. |
| app | ALTER TABLE audit_logs DISABLE TRIGGER ALL | ✅ denied — must be owner of table audit_logs | ✅ denied — must be owner of table audit_logs | no | Owner-only. Doctrine 6 lists this as a way past the append-only triggers — for the owner, not the app role. |
| app | SET session_replication_role = replica | ✅ denied — permission denied to set parameter "session_replication_role" | ✅ denied — permission denied to set parameter "session_replication_role" | no | Superuser-only. The other escape hatch doctrine 6 names. |
| app | DELETE FROM audit_logs | ✅ trigger — audit_logs is append-only (CLAUDE.md doctrine 6): DELETE is not permitted | ✅ denied — permission denied for table audit_logs | **yes** (trigger → denied) | A: privilege allows it and the 036 trigger stops it. B: refused before the trigger is reached. |
| app | UPDATE audit_logs content column | ✅ trigger — audit_logs is append-only (CLAUDE.md doctrine 6): only processed_at may be updated | ✅ denied — permission denied for table audit_logs | **yes** (trigger → denied) | Same shape as DELETE. |
| app | UPDATE audit_logs SET processed_at (the worker) | ✅ ok:1 | ✅ ok:1 | no | MUST still work: the notification queue marker. A wholesale UPDATE revoke would have been migration 036 again. |
| app | INSERT INTO audit_logs | ✅ ok:1 | ✅ ok:1 | no | Every sensitive write audits (doctrine 10). |
| app | SELECT schema_migrations | ✅ ok | ✅ denied — permission denied for table schema_migrations | **yes** (ok → denied) | Owner-only by its comment; revoked by the loop that reads the comment. |
| app | SELECT migration_runs | ✅ ok | ✅ denied — permission denied for table migration_runs | **yes** (ok → denied) | As above. |
| app | Read a tenant table through RLS | ✅ ok:rows=1 | ✅ ok:rows=1 | no | Without app_bypass_schools this returns 0 rows, silently. Asserting 1 proves the policy admits the role. |
| app | Ordinary DML: UPDATE a tenant row | ✅ ok:1 | ✅ ok:1 | no | Visible AND writable: USING (true) WITH CHECK (true). |
| login | login: read the ten user columns | ✅ ok:rows=1 | ✅ ok:rows=1 | no | Exactly what POST /login selects. |
| login | login: stamp last_login_at | ✅ ok:1 | ✅ ok:1 | no | Column-scoped, in the same style as processed_at. |
| login | login: read subscription_tier | ✅ ok:rows=1 | ✅ ok:rows=1 | no | The read the first inventory missed (a generic type argument hid pg.query). |
| login | login: read password_hash | ✅ denied — permission denied for table users | ✅ denied — permission denied for table users | no | Login verifies through Supabase Auth, so the role serving unauthenticated callers cannot read a hash. |
| login | login: change a role | ✅ denied — permission denied for table users | ✅ denied — permission denied for table users | no | Only last_login_at is writable. |
| login | login: create a user | ✅ denied — permission denied for table users | ✅ denied — permission denied for table users | no | Why /create-user moved to the app pool: otherwise this role would need it. |
| login | login: read scores | ✅ denied — permission denied for table scores | ✅ denied — permission denied for table scores | no | The point of the separate role: a flaw on the unauthenticated path reaches no tenant data. |

## Boundary check (`scripts/sql/c4a_boundary_check.sql`)

Derived from `pg_class`, table comments and `has_*_privilege` — no snapshot to
regenerate. An empty result counts only because the rows below show it returning
something when something is wrong.

| State | Held? | Expected | Violations returned |
|---|---|---|---|
| proposed grants | ✅ | must be empty | *(none)* |
| + a new table, as a future migration would create it | ✅ | exactly one violation, naming the table and the silent zero-row read — and NOT "lacks DML", which proves ALTER DEFAULT PRIVILEGES fired | c4a_future_table: no permissive policy admits chronixedu_app — the app would read zero rows from it, silently |
| + that table with its app_bypass policy | ✅ | the migration that does its job passes | *(none)* |
| + a new bookkeeping table marked owner-only | ✅ | flagged: default privileges handed it DML, and owner-only must hold nothing | c4a_future_bookkeeping: owner-only, but chronixedu_app holds privileges on it — REVOKE ALL in the migration that created it |
| + that table marked AND revoked | ✅ | the deliberate act clears it | *(none)* |
| + auth.uid() rewritten to reference schema auth | ✅ | the platform dependency is named, not discovered at cutover as failed logins | auth.uid() body references schema auth — roles without USAGE on it cannot plan queries under policies that call it |
| + auth.uid() rewritten to RAISE on an absent setting | ✅ | the check errors instead of reporting a clean result — property (b) is evaluated, not inspected | check errored: unrecognized configuration parameter "request.jwt.claim.sub" |
| REVOKEs undone (Phase A) | ✅ | the check notices both kinds of loosening | audit_logs: append-only, but chronixedu_app holds table-level UPDATE; holds DELETE<br>migration_runs: owner-only, but chronixedu_app holds privileges on it — REVOKE ALL in the migration that created it<br>schema_migrations: owner-only, but chronixedu_app holds privileges on it — REVOKE ALL in the migration that created it |
