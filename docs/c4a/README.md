# C-4a artifacts — for the second read

Nothing here has been applied to production. `grants.sql` has been applied only to a
disposable local rebuild of `migrations/`, to probe it.

The C-4a plan (`docs/AUDIT-2026-09.md`) hands these over because whoever wrote the grants
is the worst-placed person to notice what is missing from their own inventory. **Check the
artifacts against the code and against each other, not against this README.**

| File | What it is | How it was made |
|---|---|---|
| `routes.md` | All 196 routes: method, full path, guards (mount → file → route), handler, which `requireSchoolAccess` variant applies, source line; conditional registrations flagged | `scripts/c4a/inventory.js`, from source |
| `operations.md` / `.json` | All 659 table references in SQL under `apps/api/src`: op, table, file:line, function, connection | same |
| `tables.txt` | The 44 public tables | `pg_tables` on a rebuild of `migrations/` |
| `grants.sql` | The proposed grant set — two roles | written by hand |
| `probe.md` | 19 probes × 2 phases, attempted as each role; the boundary check in 7 states | `scripts/c4a/probe.js` on the rebuild |
| `effective_privileges.json` | What `information_schema` says the roles hold after `grants.sql` | same run |
| `crosscheck.md` | operations vs effective privileges, both directions, per connection | `scripts/c4a/crosscheck.js` |
| `../../scripts/sql/c4a_boundary_check.sql` | The derived boundary check — every row a violation | written by hand |

Regenerate: `node scripts/c4a/inventory.js`, then
`PROBE_DATABASE_URL=<local rebuild> node scripts/c4a/probe.js`, then `node scripts/c4a/crosscheck.js`.

## Revision 2 — what the second read changed

**Found by the reviewer:**

- **The inventory was wrong about the login connection.** It said the login client touched
  `users` only. POST /login also reads `schools.subscription_tier`; the attribution missed it
  because `pg.query<{ … }>(` puts a generic type argument between `query` and `(`. Asking
  "should login share the app role?" required knowing exactly what login does, which is how
  it surfaced. Attribution now reads the call's receiver; a crude count of `pg.query` in
  `auth.ts` (3) must match the inventory (3).
- **A future table would have been invisible.** `ALTER DEFAULT PRIVILEGES` gives it DML;
  nothing gives it an `app_bypass_` policy, so the app would read zero rows from it,
  silently. `rls_policy_inventory.txt` would notice only as "inventory out of date", and the
  reflex remedy — regenerating it — blesses the omission. Replaced by a **derived** check,
  `c4a_boundary_check.sql`: it enumerates `pg_class` and asks Postgres what each role holds,
  so there is no file to regenerate, and it names the consequence ("the app would read zero
  rows from it, silently"). The probe proves it fires by creating a table the way a future
  migration would, inside a rolled-back transaction.
- **The owner-only exclusion was a hardcoded list.** Now a property: a table comment
  beginning `owner-only:` (and `append-only:` for `audit_logs`). The REVOKE loop, the policy
  loop and the check all read the same property, so they cannot disagree. A new bookkeeping
  table is flagged — default privileges hand it DML — until its migration marks it and
  revokes; the probe shows both halves.
- **The login connection gets its own role, column-scoped.** `chronixedu_login`: SELECT on the
  ten `users` columns and `schools (id, subscription_tier)` that POST /login reads, UPDATE on
  `users (last_login_at)`, and nothing else — not even `password_hash`, since passwords are
  verified by Supabase Auth. `/create-user` (super_admin) and `/seed-test-user` (off in
  production) used the same client; they moved to the app pool so the login role needs no
  INSERT. Probed: the four things login does work; reading a hash, changing a role, creating
  a user and reading `scores` are all denied.
- **The login connection's TLS was settled in code.** It built `new Client({ connectionString })`
  with no `ssl` option, bypassing `resolveSsl()`. It now resolves through `resolveSsl()` like
  the pool and logs its own `pg_tls_verified` line (`connection: "login"`), so the boot log
  describes every connection instead of the pool only. Shipped now, independent of cutover.

**Found while acting on it:**

- **The local stub differed from production in exactly the property under test.** The first
  login probes failed with `permission denied for schema auth`. `auth.uid()` is
  `LANGUAGE sql`, which the planner inlines by re-parsing the body as the current role; the
  stub's body called `auth.jwt()` by schema-qualified name, and the new roles have no USAGE
  on schema `auth`. Production's bodies (read from `pg_proc`) name only `current_setting()`,
  so they cannot fail this way — **a reading, not a measurement**. The stub now copies
  production verbatim, and the boundary check carries a row for it: if a platform upgrade
  ever made those bodies reference schema `auth`, every query under the tenant policies —
  every login included — would fail, and the check names that instead of the incident.
  **Re-run the boundary check against production's real roles before cutover**; this is the
  row most worth seeing come back empty there.

## Where to look hardest

1. **The 62 assembled statements** (`crosscheck.md` §5) — SQL built with `${…}`.
2. **Anything registered outside `router.<verb>(…)`** — two conditional routes are flagged.
3. **The platform dependency above** — the one claim here that is read rather than measured.

## Decisions, unchanged from revision 1

- DML only, not `ALL`: TRUNCATE, REFERENCES and TRIGGER are absent by construction.
- `audit_logs`: UPDATE revoked and re-granted on `processed_at` only. "No UPDATE on
  audit_logs", read literally, is migration 036 one layer down.
- Neither role can `DISABLE TRIGGER` or set `session_replication_role` — doctrine 6's
  escape hatches stay the owner's.

## Next

- **Run the DB and integration suites under the roles** — the end-to-end proof. The harness
  must seed through an owner connection (the seed TRUNCATEs, which the role correctly
  cannot): step 5's separate connection strings, in the tests first.
- Turn `grants.sql` into a migration: roles created NOLOGIN, `LOGIN PASSWORD` set by hand at
  cutover; the boundary check becomes a DB test in the same commit.
- 40 granted-but-unused privileges (`crosscheck.md` §2): narrowing, per table, after cutover.
