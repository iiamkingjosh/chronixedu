# C-4a privilege probe (generated — `node scripts/c4a/probe.js`)

Run against a **local rebuild** of `migrations/`, as a NOLOGIN `chronixedu_app` role via
`SET LOCAL ROLE`, each probe in its own rolled-back transaction. **Phase B** is
`grants.sql` as proposed; **Phase A** is the same with its REVOKEs undone. A REVOKE is
justified only where the phases differ. Production is PG 17.6, this rebuild PG 16 — the
semantics probed here did not change between them, but the plan requires re-running this
against the real role before cutover.

**24 of 24 expectations held.** 42 `app_bypass_*` policies for 44 tables (bookkeeping tables excluded by design).

| Probe | A: without REVOKEs | B: as proposed | Does a REVOKE change it? | Why |
|---|---|---|---|---|
| TRUNCATE a tenant table | ✅ denied — permission denied for table notices | ✅ denied — permission denied for table notices | no | Never granted — DML only. The plan expected ALL to include TRUNCATE; with DML-only it is absent by construction. |
| CREATE TABLE in public | ✅ denied — permission denied for schema public | ✅ denied — permission denied for schema public | no | PG15+ gives PUBLIC no CREATE on public, and USAGE is not CREATE. No revoke needed; none written. |
| ALTER TABLE audit_logs DISABLE TRIGGER ALL | ✅ denied — must be owner of table audit_logs | ✅ denied — must be owner of table audit_logs | no | Owner-only. Doctrine 6 lists this as a way past the append-only triggers — for the owner. Not for the app role. |
| SET session_replication_role = replica | ✅ denied — permission denied to set parameter "session_replication_role" | ✅ denied — permission denied to set parameter "session_replication_role" | no | Superuser-only. The other escape hatch doctrine 6 names; closed to the app role. |
| DELETE FROM audit_logs | ✅ trigger — audit_logs is append-only (CLAUDE.md doctrine 6): DELETE is not permitted | ✅ denied — permission denied for table audit_logs | **yes** (trigger → denied) | A: privilege allows it and the 036 trigger stops it. B: refused before the trigger is reached. The REVOKE moves enforcement a layer earlier. |
| UPDATE audit_logs content column | ✅ trigger — audit_logs is append-only (CLAUDE.md doctrine 6): only processed_at may be updated | ✅ denied — permission denied for table audit_logs | **yes** (trigger → denied) | Same shape as DELETE. |
| UPDATE audit_logs SET processed_at (the worker) | ✅ ok:1 | ✅ ok:1 | no | MUST still work: this is the notification queue marker. Revoking UPDATE wholesale would have been migration 036 again. |
| INSERT INTO audit_logs | ✅ ok:1 | ✅ ok:1 | no | Every sensitive write audits (doctrine 10). |
| SELECT schema_migrations | ✅ ok | ✅ denied — permission denied for table schema_migrations | **yes** (ok → denied) | Owner bookkeeping. Only src/scripts/migrate.ts touches it, on the owner connection. |
| SELECT migration_runs | ✅ ok | ✅ denied — permission denied for table migration_runs | **yes** (ok → denied) | As above. |
| Read a tenant table through RLS | ✅ ok:rows=1 | ✅ ok:rows=1 | no | RLS switches on for a non-owner; without app_bypass_schools this returns 0 rows, silently. Asserting 1 proves the bypass policy works. |
| Ordinary DML: UPDATE a tenant row | ✅ ok:1 | ✅ ok:1 | no | WITH CHECK (true) on the bypass policy; the row must be visible AND writable. |
