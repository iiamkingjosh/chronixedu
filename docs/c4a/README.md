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
| `probe.md` | 19 probes × 2 phases, attempted as each role; the boundary check in 8 states | `scripts/c4a/probe.js` on the rebuild |
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
  `LANGUAGE sql`, which the planner inlines by re-parsing its body as the current role; the
  stub's body *named* `auth.jwt()`, and the new roles have no USAGE on schema `auth`. (Not a
  missing missing_ok flag — the stub's `auth.jwt()` had `current_setting(…, true)` and never
  raised.) The stub now copies production verbatim.

### The platform dependency, stated precisely

A first summary of this ("if a Supabase upgrade changed them, every login would break") was
too broad and was corrected on review. C-4a depends on **two specific properties** of
Supabase's `auth.*` functions, which fail differently:

| Property | If violated | Does an OR'd `USING (true)` rescue it? | Checked |
|---|---|---|---|
| **(a)** bodies never *name* schema `auth` | error at **planning**, on every query under a policy calling the function — both roles, logins included | **No** — measured: the login probes failed with `login_read_users` in place, because inlining happens before policies are combined and folded | boundary check inspects `prosrc` |
| **(b)** bodies never *raise* on an absent setting (`missing_ok`) | error at **runtime** | **Yes** — `true OR f()` is folded away before `f()` runs, so our roles' bypass policies cover it | boundary check *calls* them; the probe shows the check erroring when a body raises |

Production satisfies both today: its bodies name only `current_setting(…, true)` (read from
`pg_proc`). Both are properties of SQL this project does not control — which is an argument
for C-4b beyond tenant isolation: `current_setting('app.school_id', true)` is our own setting
with our own missing_ok flag. **Re-run the boundary check against production's real roles
before cutover** — the only step that turns "read" into "measured" here.

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

## Suites under the roles — done for the DB suite

`npm run test:db:roles` (`jest.db.roles.config.js`) runs the whole DB suite with the app pool
connected as `chronixedu_app`, holding exactly `grants.sql`. The seed connects as the owner
through its own short-lived client (it TRUNCATEs, which the role correctly cannot).
`c4aRoleMode.db.test.ts` asserts which user each connection actually is, in both modes — a
role-mode run that had silently fallen back to the owner would otherwise report the same
zero product failures as a correct one (doctrine 16).

**Result: 212 passed, 3 skipped (the policy-drift test, skipped at collection in this mode
by design), 0 failed.** No product route hit `permission denied`. The first run had 17
failures, all tests doing owner work through the app pool — switching to `anon` /
`authenticated`, proving the audit trigger fires *for the owner*, creating a stand-in
`auth.users` — each now on an explicit `owner` connection named in the test.

It also found a product defect: a deadlock between the next test's seed and an
`INSERT INTO audit_logs` still in flight from the previous test. That INSERT was the parent
notification queue row, written fire-and-forget while the publish response claimed it had
been queued (SECURITY.md Round 14, fixed).

## Next

- **The integration suite under the roles**, including POST /login on `chronixedu_login` —
  the DB suite does not exercise the login route.
- Turn `grants.sql` into a migration: roles created NOLOGIN, `LOGIN PASSWORD` set by hand at
  cutover; the boundary check becomes a DB test in the same commit.
- 40 granted-but-unused privileges (`crosscheck.md` §2): narrowing, per table, after cutover.
