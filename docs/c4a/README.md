# C-4a artifacts — for the second read

Nothing here has been applied to production. `grants.sql` has been applied only to a
disposable local rebuild of `migrations/`, to probe it.

The C-4a plan (`docs/AUDIT-2026-09.md`) hands these over precisely because whoever wrote
the grants is the worst-placed person to notice what is missing from their own inventory.
So: **check the artifacts against the code and against each other, not against this
README.** Everything below is one reader's account.

| File | What it is | How it was made |
|---|---|---|
| `routes.md` | All 196 routes: method, full path, guards (mount → file → route), handler, which `requireSchoolAccess` variant applies, source line | `scripts/c4a/inventory.js`, from source |
| `operations.md` / `.json` | All 659 table references in SQL under `apps/api/src`: operation, table, file:line, enclosing function, connection | same |
| `tables.txt` | The 44 public tables | `pg_tables` on a rebuild of `migrations/` |
| `grants.sql` | The proposed grant set, role creation excluded (its password must not be in the repo) | written by hand |
| `probe.md` | 12 probes × 2 phases, attempted as the role | `scripts/c4a/probe.js` on the rebuild |
| `effective_privileges.json` | What `information_schema` says the role holds after `grants.sql` | same run |
| `crosscheck.md` | operations vs effective privileges, both directions | `scripts/c4a/crosscheck.js` |

Regenerate: `node scripts/c4a/inventory.js`, then
`PROBE_DATABASE_URL=<local rebuild> node scripts/c4a/probe.js`, then `node scripts/c4a/crosscheck.js`.
The probe refuses any host but localhost.

## What was checked, and how each check was itself checked

- **Route extraction** was compared with a crude count of `router.<verb>(` calls. The first
  version missed two — `POST /api/auth/reset-password` and `/confirm-reset`, both
  unauthenticated — because a regex ran past a *named* handler into the next
  registrations. Replaced with an argument scanner; now 196 = 196, file by file.
- **The probe** runs each operation twice, with and without the REVOKEs, so every REVOKE
  must change an outcome to justify itself. Probes expecting success assert rows affected,
  so an UPDATE that matched nothing cannot pass. 24/24 held.
- **The cross-check** reports 0 operations used-but-not-granted. Because zero is what an
  empty input or a broken filter also produces (CLAUDE.md doctrine 16), five operations
  were planted: it reported exactly the four that should fail and passed the fifth, the
  notification worker's `UPDATE audit_logs SET processed_at`.

## Where to look hardest

1. **The 62 assembled statements** (`crosscheck.md` §5) — SQL built with `${…}`. The table
   was found; a conditional JOIN or a fragment in a variable could hide another.
2. **Anything registered outside `router.<verb>('literal', …)`** — the extractor would not
   see it. Two conditionally-registered routes are flagged (`/seed-test-user`,
   `/test-role`, both off in production).
3. **Whether the login client should share the app role.** It only touches `users`.

## Decisions taken, and one correction to the plan

- **DML only, not `ALL`.** The plan says "GRANT broadly, then REVOKE by operation". `ALL`
  includes TRUNCATE, REFERENCES and TRIGGER, which no application code issues, so they
  are never granted. The probe confirms TRUNCATE is denied by construction.
- **`audit_logs` UPDATE is column-level, not revoked.** The plan's text says "no
  DELETE/UPDATE on `audit_logs`". Applied literally that is migration 036 again one layer
  down: the notification worker updates `processed_at`, and a wholesale UPDATE revoke
  silences every parent notification. `grants.sql` revokes UPDATE and re-grants
  `UPDATE (processed_at)` — enforcing at the privilege layer what 037's trigger enforces.
- **The app role cannot disable triggers or set `session_replication_role`.** Both are
  doctrine 6's escape hatches for the owner; the probe shows both denied to the role.
  That is the concrete gain of C-4a.

## Not yet done — C-4a steps that follow the second read

- The executable proof: run the DB and integration suites with the pool connected as the
  role. It needs the test harness to seed through an owner connection (the seed TRUNCATEs,
  which the role correctly cannot) — i.e. step 5's three connection strings, in the tests
  first.
- The TLS question on the login client (`crosscheck.md` §3): measured before it is fixed.
- 40 granted-but-unused privileges (§2) — narrowing, per table, after cutover.
