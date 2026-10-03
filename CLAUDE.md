# CLAUDE.md — Chronix Edu agent rules

Read this before every task. It describes the system **as built** (September 2026).
Where the PDFs in `docs/spec/` disagree with this file, this file wins — see
"Spec drift" at the bottom. Audit history: `docs/AUDIT-2026-09.md`, `SECURITY.md`.

## What this is

Multi-tenant school management SaaS for Nigerian private schools. No real paying
client is live yet — every school currently in the database is either a test
fixture (created by an integration test, never cleaned up — see `L-test-data`
in `docs/AUDIT-2026-09.md`) or demo/sandbox data, all marked `is_demo`, plus Moses's own
pilot (Chronix High School). There is no seed script: the old demo seeder, which wiped
every school and every Supabase Auth user with no guard and committed staff passwords to
this public repo, was deleted on 1 Oct 2026 and removed from git history the same day (the
rewrite changed every commit ID since June 2026; SECURITY.md Round 23 has the old→new map and
what GitHub may still serve). Removing it does not un-leak the passwords: rotation is the fix,
and is tracked as open until confirmed. Schools are removed one at a time, with a dry run and host checks, by
`apps/api/scripts/delete-school-data.js`. Treat this repo's "production" database as
pre-launch: no real student, parent, or payment data exists in it as of 18 Sep 2026.
Monorepo, npm workspaces:

| Path | What |
|---|---|
| `apps/api` | Express + TypeScript. All business logic and all DB access. Railway. |
| `apps/web` | Next.js 14 App Router + Tailwind. Talks only to `apps/api`. Railway. |
| `migrations/` | Plain SQL, applied in filename order by `npm run migrate`. |
| `scripts/sql/` | Test stubs and one-off, reviewed operational SQL. |
| `docs/spec/` | Original PRD, architecture guide, agent file, build prompts, test plan (historical). |

## Non-negotiable doctrines

1. **Tenant id comes from the verified JWT, never the request.** Every
   `/api/schools/:schoolId/...` route runs `requireSchoolAccess`
   (`req.user.school_id === req.params.schoolId`, super_admin excepted) and
   filters every query by `school_id`. Never trust `school_id` in a body/query.
   ⚠️ **`requireSchoolAccess` is defined per route file and they are NOT identical.**
   Most files define the permissive version above; `routes/users.ts` defines one
   that admits **only super_admin and principal**. Read the definition in the file
   you are working in before concluding a route is or isn't guarded — a Round 10
   audit pass misreported an endpoint as world-readable by assuming the common
   version. When a route's access differs from its file's norm, add an explicit
   `requireRole(...)` so the intent is visible at the call site.
2. **RLS is defence in depth, not the enforcement layer.** The API's `pg` pool
   connects as the table owner and **bypasses RLS**. Isolation lives in route
   guards + `WHERE school_id = $n`. Every table still has RLS enabled (CI
   asserts it) so the Supabase REST endpoint exposes nothing.
3. **Validate the target, not just the caller.** A teacher assigned to a class
   may only write rows for students enrolled in that class for the term's
   session (`findStudentsNotInClass`). Components must belong to the resolved
   assessment config (`getAllowedComponentIds`).
4. **Scores are unique per `(student_id, subject_id, term_id, component_id)`.**
   Component ids are shared across subjects by class-level/default configs.
   Any score lookup or upsert without `subject_id` is a bug.
5. **Result workflow has two levels.**
   - `subject_result_status` (class + subject + term): `draft → submitted`.
     Teacher submit, score lock, principal return act here.
   - `result_status` (student + term): `draft → approved → published`.
     Approve requires every assigned subject submitted. Publish requires all approved.
   - `published` is final. Return moves approved → draft and submitted subjects → draft.
   - Guard every student-level change with `validateStatusTransition`.
   - **Parent- and student-facing score data requires `result_status === 'published'`.**
     Not `approved`, and not "a report card exists". The four routes that expose
     scores to those roles (`parent.ts` snapshot + results, `student.ts` dashboard +
     results) each gate on it explicitly; `computeClassResults` reads raw `scores`
     and applies no workflow filter of its own, so any new caller that serves a
     parent or student must apply the gate itself. Gating only the report-card PDF
     is not sufficient — that was the Round 10 H-01 defect.
6. **Audit enforcement is accident-proofing, not tamper-proofing.** Migrations 036–038
   block DELETE and content UPDATE on `audit_logs` for every caller including the table
   owner, and make `processed_at` write-once. They do **not** block TRUNCATE (a
   `BEFORE TRUNCATE` trigger is incompatible with the DB suite's `TRUNCATE … CASCADE`,
   which reaches `audit_logs` through its FKs whatever the table list says), nor
   `ALTER TABLE … DISABLE TRIGGER ALL`, nor `session_replication_role = 'replica'`. It
   stops a cleanup script and a careless migration; it does not stop someone who means it.
   Since 048 there is one sanctioned DELETE: the school purge path. It is a function, never a flag
   (see "A school's data").
7. **A guard must be verified against every operation it forbids, one at a time.**
   Migration 036's header said "nothing deletes from audit_logs, so this breaks no
   existing path" — true, and beside the point, because it banned DELETE *and UPDATE*
   while only DELETE had been checked. `audit_logs` is also the notification worker's
   queue, so the unchecked half silenced every parent notification, quietly. Enumerate
   the forbidden operations in the migration header and grep for each separately, and
   ask which operation actually produced the rows you are trying to prevent. 038's own
   activation guard failed this test: it covered UPDATE while all 29 offending rows in
   production came from INSERT, so it guarded the path that produced none of them.
8. **Never infer "the user chose this" from "the value equals the default."** Whether a
   value was set and what the value is are two different facts, and the second cannot
   derive the first. Three instances so far, each with a different mechanism: `is_demo`
   inferred from an email domain (which is why it is a one-time backfill and must never
   be a live rule); `promotion_cutoff ?? 40`, where an unset pass mark was
   indistinguishable from a deliberately chosen 40; and `is_default` on the fee minimum,
   which told a school that chose ₦1,000 — the figure we recommend, so the likeliest
   choice — that it had not chosen one. A fourth, at scale: every new school was born
   with `NIGERIAN_DEFAULTS` (a five-band scale, a 40% pass mark, four assessment
   components) written into its settings, so every school "had" choices nobody made. Since
   1 Oct 2026 nothing is seeded (`newSchoolAcademicConfig`), and publishing refuses until a
   scale is set. And `is_demo DEFAULT FALSE` made every school a customer until someone said
   otherwise; it is now stated at creation (migration 049). And the trial gate signed its changes
   with `role = 'super_admin' LIMIT 1`: "which admin did this" answered by whichever row Postgres
   returned first, a test fixture on Chronix High School's 8 Sep suspension. It now signs with a
   fixed system account (migration 053). The check is mechanical: ask
   whether a field answers *what* or *whether*, and record the second separately when you
   need it.
9. **Advisory output is indistinguishable from no output once you have decided to push.**
   The corollary to doctrine 7: verifying what a guard *does* is useless if the guard only
   reports. The lint scripts therefore carry `--max-warnings` pinned to the current count
   (api 1, web 4), so an existing warning stays tolerated and a NEW one fails at the
   moment of introduction rather than scrolling past in pre-commit hook output.
   Proof this was needed: a new unused-import warning was introduced and pushed in
   3abbabe with the hook reporting it the whole time.
   **It freezes the count; it does not shrink it.** Nothing decrements the number, so
   the remaining warnings are permanent-by-default rather than accumulating — strictly
   better, and a different claim. Going down takes someone fixing a warning *and*
   lowering the number in the same commit, and nothing here prompts that. Never raise
   them: a raise is the ratchet being removed, one notch at a time. First notch down:
   web 5 → 4 on 1 Oct 2026, when the one-term onboarding step put the unused
   `termSchema` to use.
10. **Every sensitive write is audited** (`logAudit`, or an `audit_logs` insert in
   the same transaction for batch writes): scores (old + new), result status,
   settings, payments, support-session actions. `audit_logs` has no DELETE, except migration
   048's purge path, which deletes one whole school's rows for the deletion runbook and nothing else.
   **An old value is read, never assumed.** `logSettingsChange(…, null, patch)` recorded
   "prior: null" for every grading and fee change (SECURITY.md Round 15); read the prior
   value under the same lock as the write (`mergeSettingsColumn`), and test it positively —
   the second of two saves must name the first's value.
11. **Money:** Postgres `numeric(12,2)` naira today. Never add/subtract money in
   JS floats — do arithmetic in SQL, or convert to integer kobo first. New money
   columns should be `bigint` kobo.
12. **Crons run through `runExclusive(name, fn)`** (Postgres advisory lock) and
   schedule with `{ timezone: CRON_TIMEZONE }` (Africa/Lagos). Any user-facing
   time-of-day logic on the server uses Africa/Lagos, not server time.
13. **The service role key never leaves the API** and is never logged, not even a prefix.
14. **The deployed policy set must equal the one `migrations/` builds.** Measured once, the
   hard way: a rebuild into an empty database produced 64 policies where production held 81.
   All 64 matched production byte for byte — no divergence anywhere, 17 orphans. Sixteen
   were `service_role_bypass` on the 001-era tables, which predate the convention; one,
   `"Users can read own notifications"`, was created by hand in the Supabase dashboard and
   existed in no file. Migration 042 codified the sixteen and dropped the one. CI could not
   see any of it, and that is the part worth keeping: `tenantIsolation.db.test.ts` asserts
   RLS is *enabled*, which was true on both sides the entire time — a real guard, passing
   honestly, measuring a property that cannot fail when this fails.
   `rlsPolicyDrift.db.test.ts` now pins the migration side against
   `scripts/sql/rls_policy_inventory.txt`, and `scripts/sql/rls_drift_check.sql` is the
   other half — the only one that can see a policy made in the dashboard, so run it against
   production after any RLS work. Resolve an orphan by dropping it or by codifying it, but
   in a migration either way.

15. **A bug whose trigger is contention needs a loaded reproduction; a clean run is the
   wrong instrument.** The DB-suite flake looked unreproducible for two days because every
   attempt to reproduce it was a clean, quiet run. It fired twice in two runs the moment a
   discriminator was accidentally run under load — re-reading a working tree mid-edit,
   competing for CPU with other jest processes. A contaminated experiment that reproduces
   the bug beats a clean one that cannot. The corollary is doctrine 9 applied to the test
   harness: **a timeout that stops waiting is not a timeout that stops work.** Jest's
   `testTimeout` abandoned `beforeEach(seed)` but Node does not cancel an in-flight query,
   so the remaining INSERTs committed after the next test's TRUNCATE and surfaced as
   `duplicate key` in an unrelated suite. Raising the number would have lowered the
   frequency and kept the mechanism. The fix lives at the layer that can stop the work:
   `seed()` is one transaction with `SET LOCAL statement_timeout` and
   `idle_in_transaction_session_timeout` below Jest's, so Postgres rolls back and the
   failure lands in the test that owns it. Jest's timeout is the outer backstop, not the
   guard. A second instance surfaced the same day: `cronLock.db.test.ts` slept 100ms and
   assumed the first job held a lock by then, and under load it deadlocked itself. **A
   sleep in a test is a guess about scheduling standing in for a synchronisation** —
   await a signal the code under test emits instead. And **a timeout reports where it was
   waiting, which is rarely where the fault is**: `pg-pool`'s "timeout exceeded when trying
   to connect" named the database while the process was being descheduled by a paging
   host and Postgres sat idle. Of the three timeouts met this week, only
   `statement_timeout` both stopped the work and named the cause.

16. **An assertion whose expected outcome is "nothing" cannot tell "did the right thing"
   from "did nothing."** For every assertion of zero, empty, absent, null or unchanged,
   ask what *else* produces that result; if a no-op does, establish the non-empty state
   first and assert it. Four instances in four days, each a different mechanism:
   `total_mrr: 0` (no subscriptions, or a broken query); the lint ratchet's baseline
   (passing whether or not it would bite); "no 5000ms timeouts" across four concurrent runs,
   three of which destroyed each other's evidence; and "overrides empty after clearing",
   which a save that silently never happened also produces — that test passed against the
   broken UPDATE until it was made to assert the override existed first. More mechanical
   than doctrine 7, and it would have caught all four without anyone needing to be clever.
   223 such assertions exist across the three suites as of 28 Sep 2026; the sweep is an
   open item in `docs/AUDIT-2026-09.md`.

## Auth (as built)

- **The login connection** (`routes/auth.ts getLoginClient`) serves POST /login and nothing
  else — the one place the database is reached for an unauthenticated caller. Keep it that
  way: C-4a gives it its own column-scoped role (`docs/c4a/grants.sql`), so anything added to
  it widens that role. Its TLS resolves through `resolveSsl(url, 'login')` like the pool;
  every connection the API opens must, and each logs its own `pg_tls_verified` line.
- **The client's address is `clientIp(req)` — `X-Real-IP` — never `req.ip`.** On Railway,
  `X-Forwarded-For` holds two Railway addresses and no client, and the edge overwrites both
  headers, so `trust proxy` at any depth yields a Railway proxy; measured 30 Sep 2026
  (SECURITY.md Round 18). Rate-limit keys, lockout keys and both audit tables' `ip_address`
  go through `clientIp`. A new `req.ip` reader is a regression.
  - **`audit_logs.ip_address` was never written until 3 Oct 2026** (SECURITY.md Round 32). 262 rows
    in production had none, while this file said they did. `platform_audit_logs`, written directly
    in `superAdmin.ts`, did.
  - **`logAudit` now requires `ipAddress`, so the compiler refuses an audit call that does not say
    where it came from.** Pass `clientIp(req) ?? null`. Write `null`, with a comment, where there is
    no request, or where the request is not the actor's own: a Paystack webhook, or settlement. Do
    not use a request context (AsyncLocalStorage): `multer` loses it, so every upload's audit row
    would record null without a word (measured).
- **Every link the API sends starts with `appBaseUrl()`** (`config/appUrls.ts`), which reads
  `APP_URL` and nothing else. There is no default: the API refuses to start without `APP_URL`
  (`config/env.ts`), and `appBaseUrl()` throws if reached without it. Tests state theirs
  (`jest.setupEnv.js`, `__db_tests__/env.ts`). Until 2 Oct 2026 there were eight expressions with
  three fallbacks, and the onboarding email read `NEXTAUTH_URL`, a leftover `http://localhost:3000`
  in production. So a new school's first email sent its principal to their own machine.
  `NEXTAUTH_URL` is read nowhere. `appUrls.test.ts` fails if anything outside `appUrls.ts` reads
  `APP_URL` or names `NEXTAUTH_URL`.
- **The API is a second origin, so every JSON request preflights.** `edu.` and
  `api.chronixtechnology.com` are different origins, and a JSON POST is not a simple request.
  - **The cache:** `config/cors.ts` sends `Access-Control-Max-Age: 7200`, which is Chrome's cap.
  - **What it fixed:** without the header, Chrome re-asked every 5 seconds, and the preflight was the
    0.9–2.9 s of "Queueing" in the sign-in baseline. Measured 2 Oct 2026: 2,319 ms cold, 376 ms on a
    warm connection, 1 ms cached.
  - **The cost:** a tightened `CORS_ORIGIN` takes up to 2 hours to reach browsers that have already
    cached a preflight.
  - **Serving the API under `edu.chronixtechnology.com/api/*` would delete the preflight, and is
    deliberately not done.** It puts a proxy in front of the API, which changes what arrives as the
    client address. The rate limits, the login lockout and `audit_logs.ip_address` all key on that
    address through `clientIp`, and all three would keep working while keying on the wrong value.
    If it is ever done, redo Round 18's measurement first, before the change.
- **Redis is best-effort on the request path** (SECURITY.md Round 19, decided: fail open).
  The shared client has `commandTimeout: 500`; every read or write of a limit, lockout or
  cache goes through `bestEffort(event, op)` in `middleware/rateLimit.ts`, which logs and
  returns `undefined`, and all five limiters carry `passOnStoreError: true`. A bare
  `await redis.x()` on a request path is a regression: it turns a Redis outage back into
  500s and 503s. The exceptions are the support-session token store and blacklist writers
  in `superAdmin.ts`. While Redis is down both brute-force controls are off; since 1 Oct 2026 the first failure
  raises the `redis_unavailable` Sentry alert (`config/alerts.ts`), once per 15 minutes. Until
  then nothing alarmed (`docs/AUDIT-2026-09.md`). The one exception to fail-fast is boot: the
  limiters' script loads wait for Redis's first `ready` (`redisTransport`, bounded 10 s), because
  building them before the connection raised a false alert (CHRONIXEDU-API-2). Nothing waits after.
- Login: Supabase `signInWithPassword` verifies the password; the API then signs
  its **own** HS256 JWT (`JWT_SECRET`, 1h) with `user_id, school_id, role, email,
  title, must_change_password, subscription_tier`. Supabase-issued tokens are
  not used anywhere else.
- **`POST /forgot-password` answers the same 200 and body for every well-formed request, before any
  email is attempted** (`sendResetEmail` runs after the response; a failure is logged by user id).
  Never await the send in the handler, or vary the answer on its result: the answer or its timing
  would again say whether an account exists (SECURITY.md Round 24).
- **The reset email and where it lands.** Observed 2 Oct 2026 by following a real email from the
  app's own flow. Most of this lives in dashboards and in no file.
  - **The email.** Supabase sends it through custom SMTP (SendGrid, `no-reply@chronixtechnology.com`),
    with a custom template. Its link has the `{{ .ConfirmationURL }}` shape:
    `…supabase.co/auth/v1/verify?token&type=recovery&redirect_to=https://edu.chronixtechnology.com/reset-password`.
  - **SendGrid click tracking was on, account-wide, until 2 Oct 2026.** It wrapped every link in
    `ct.sendgrid.net`, so SendGrid saw every recovery token, and a mail scanner following the tracking
    link could use one up before the person clicked. Moses turned click and open tracking off; read
    back through the API's key at 11:45 UTC. Whether Supabase's SMTP sends through that same account
    shows only in a reset email: its link must not start `ct.sendgrid.net`. Keep tracking off.
  - **What arrives.** supabase-js defaults to the implicit flow, so a working link lands with
    `#access_token…&type=recovery`, and a used or expired one with
    `#error=access_denied&error_code=otp_expired`.
  - **The page.** `lib/resetLanding.ts` reads both shapes, plus PKCE's `?code=`, which it recognises
    but cannot use (that needs a verifier the page never holds). Each cause gets its own message,
    one short sentence saying what happened and never why: the "Request a new link" button carries
    the next step, and the report to the server carries the cause.
  - **The report.** The page reports a landing it cannot use to `POST /api/auth/reset-landing`, with
    no address and no token. An unreadable link alerts (`password_reset_cannot_complete`), as does a
    login with no app account at confirm-reset (`NO_APP_ACCOUNT`). Routine failures are warnings.
  - **Never send a reset from the Supabase dashboard.** It attaches no `redirect_to`, so the link lands
    on the Site URL (the home page), where nothing reads it. Use the app's Forgot password.
- Roles (`public.users.role`): `super_admin, principal, teacher, registrar, bursar, parent, student`.
- Middleware chain on `/api/schools`: `detectSupportSession → verifyToken →
  requirePasswordChanged → requireActiveSchool → router`. Routes additionally
  use `requireSchoolAccess` + `requireRole(...)`.
- Support sessions (impersonation) require the `x-support-session-id` header and
  a live `support_sessions` row. `ROOT_ADMIN_EMAIL` alone may manage other
  super_admins and wipe school data.
- Web stores the token in `localStorage` (`chronixedu_token`). `apiFetch`
  redirects to `/login` on 401 unless called with `deferAuthRedirect: true`,
  which throws `SessionExpiredError` so the caller can save unsaved work first.

## Conventions

- API response envelope: `{ success: true, data }` / `{ success: false, error: { code, message } }`.
  Status codes: 400 validation, 401 auth, 403 role/tenant, 404, 409 conflict/transition, 422 bulk validation, 423 locked.
- Validate every body/query with zod before touching the DB. Parameterised SQL only.
- DB access lives in `apps/api/src/db/queries/*`; routes orchestrate, services hold business logic.
- API logging via `logger` (winston). No `console.log` in app code.
- **Sentry gets technical data only**, because the DPA names it a sub-processor on that basis.
  **The API sends a request's method and path, and nothing else** (`config/sentry.ts`, since 3 Oct
  2026, SECURITY.md Round 33). The SDK's defaults sent the body, headers and query string with every
  error and every sampled trace: a traced login sent its password, and every request its bearer
  token. Body capture is off, and `scrubRequest` cuts every event and trace before it is sent.
  `sentryScrub.test.ts` plants a secret in each place a request carries one and searches everything
  Sentry receives. A new Sentry integration or option must keep that test green.
  `Sentry.setUser` takes the user **id** and nothing else (it sent emails until 1 Oct 2026,
  SECURITY.md Round 21). Replay keeps `maskAllText`, `maskAllInputs` and `blockAllMedia`
  stated explicitly in `instrumentation-client.ts` (named `sentry.client.config.ts` until 1 Oct 2026). Never put a name, email, phone number or
  student record in a Sentry tag, context or breadcrumb.
- **The API alerts through an allow-list, `config/alerts.ts`** (since 1 Oct 2026). A winston format
  sends the log events listed in `ALERTS` to Sentry, each under one alert name, at level `error`
  (the level measured to trigger the email rule), once per 15 minutes per process, grouped by name
  and environment, carrying only the fields named for it. Everything else stays in the logs. Every
  `logger.error` event must be in `ALERTS` or in `NOT_ALERTED` with a reason: `alerts.test.ts` fails
  on a new one, on a listed name that no longer exists in the code, and on a computed event name. So
  add a new error event to one list in the same commit, and rename an event in both places. Never
  pipe all of winston to Sentry: a flooded Sentry is ignored.
- Web: all HTTP through `lib/api.ts` (`apiFetch`, `apiUpload`, `apiFetchBlob`). Forms use React Hook Form + zod.
  A failed request throws `ApiError` (`lib/apiError.ts`): a readable `message` and, for zod
  validation failures, `fields` (field → readable message) a form can attach with `setError`.
  The API answers validation with `error.flatten()`, and the client used to `JSON.stringify` it,
  so raw `{"formErrors":…}` reached the screen on every page that showed `err.message` (fixed
  1 Oct 2026). Never render an API error object; never disable a submit button just because the
  form is invalid. A click must validate and show the field errors, or the screen looks broken.
  Offline score/attendance writes go through Dexie (`lib/offlineDb.ts`).
- Path alias `@/` in web. Keep files where their siblings are.
- **The sidebar is `lib/navigation.ts`.** The principal's daily work is four labelled groups
  (11 links); Settings is ONE sidebar entry whose sub-nav lives in `settings/layout.tsx`, with
  `/settings` an index page. Labels must not collide even singular-vs-plural
  (`lib/__tests__/navigation.test.ts` — "Report Cards" beside "Report Card" was the wrong-click
  it exists for). Nothing reorders by usage. "School-wide Grading" and "Grading by Level" stay
  two pages: merged behind a level selector, the page would show a level's *effective* values
  and a save would pin them (doctrine 8). Web unit tests run with `npm run test` in `apps/web`
  (jest, pure TypeScript under `lib/`), and the root `test:unit` runs them after the API's.
- **The Ctrl+K palette (`components/CommandPalette.tsx`) has no page list of its own.**
  `lib/commandPalette.ts` builds it from `getNavGroupsForRole`, which rests on
  `getMainNavForRole`, plus `SETTINGS_NAV_GROUPS` gated by `settingsAccessForRole`, the one rule
  the school sidebar also reads (`all` | `payout` | `none`). Add a page to `navigation.ts` and
  both the sidebar and the palette get it; never add one to the palette alone, or it will offer
  a page the role's guard refuses. **The platform-admin area is the same rule**: its ten pages
  are `SUPER_ADMIN_NAV_GROUPS` in `navigation.ts` (they used to be a private list inside
  `app/super-admin/layout.tsx`). That layout renders its sidebar from them and mounts the palette,
  and `getMainNavForRole('super_admin')` returns them, not `PRINCIPAL_NAV`: a super admin has no
  school, so school pages and school Settings are not theirs (`settingsAccessForRole` → `none`).
  A test pins both directions: the platform palette offers exactly the platform pages, and no
  school role's palette offers one. `commandPalette.test.ts` asserts, per
  role, that the palette's set EQUALS the expected set, not merely that it is non-empty. It
  searches pages only; record search needs its own API, tenant scoping and per-record checks.
  It renders only in the signed-in dashboard layout, never pre-auth. It matches label and
  description, so "pass mark" finds the grading pages.
- Record security fixes in `SECURITY.md` (next round, existing format) and
  user-visible changes in `docs/CHANGELOG.md`, in the same PR as the change.
- New integration tests in `apps/api/tests/` must delete the rows they create in `afterAll`,
  with one family of exceptions that migrations 036/037 created. `audit_logs` is
  append-only at the database level, so a test cannot delete its audit rows — and because
  `audit_logs` holds FKs to both `users` and `schools`, it cannot delete an audited **user**
  or their **school** either. Teardown therefore guards those deletes:
  `AND id NOT IN (SELECT user_id FROM audit_logs WHERE user_id IS NOT NULL)` and the
  `school_id` equivalent, leaving the audited ones behind.
- **A test that returns early counts as a pass.** `if (skip) return;` inside `it()` is
  reported by Jest as PASSED, so a run where the assertions never executed is
  indistinguishable from one where they held — doctrine 9 inside a test.
  `tests/resultEngine.test.ts` did this for three and a half months: it needed a student's
  scores to exist in whatever database it hit, the integration fixture never seeded them,
  and the integration count carried three passes that tested nothing. Two of them would
  also have *thrown*, because migration 028 had since removed the constraint their
  `ON CONFLICT` named — the skip hid a broken test, not just an idle one. Either build the
  fixture the test needs (preferred — `__db_tests__` has a deterministic `seed()`), or skip
  with `it.skip` / a probe whose stated reason reaches the output, as
  `studentsBulkImport` does. Never a `console.warn` and an early return.
- **Never swallow an error.** `.catch(() => {})`, `=> undefined`, `=> null` and an empty `catch {}`
  fail `alerts.test.ts` unless the handler carries `// silent-ok: <reason>` (two ROLLBACKs that
  rethrow, the alert sender's own catch). Log a named event instead and classify it in
  `config/alerts.ts`. Seven silent paths were found on 1 Oct 2026, one an audit write (SECURITY.md
  Round 28). The ratchet sees only what is LOGGED, so a dropped error is the one failure it cannot.
- **Never write a queue row or an audit row fire-and-forget, and never swallow its failure.**
  `audit_logs` doubles as the notification queue (`*_NOTIFICATION_QUEUED`), so a write that
  outlives its request, or ends in `.catch(() => {})`, can lose a parent notification while
  the response says it was queued — which `POST /results/publish` did. Await it; if the
  write can fail without undoing the operation, log the failure and make the response say
  so (`notifications_queued: false`). Found because an un-awaited INSERT deadlocked with
  the next test's seed.
- **A welcome email carries no credential** (item H2, option (iii), 1 Oct 2026). Staff and parent
  welcome emails (`services/welcomeEmail.ts`) say the account is ready and how to set a password
  with Forgot password. Platform admins too, since 2 Oct 2026 (`platformAdminWelcomeBody`; SECURITY.md
  Round 30): `POST /super-admin/admins` refuses a `password` and takes the address twice. The principal's carries a one-time set-password link (Round 27). The mailbox
  is then the key, so check the address before any account exists:
  - one parent: the address is typed twice (`email_confirmation`);
  - a bulk import: the preview returns `mailed_addresses`, and the commit refuses without
    `mailed_addresses_confirmed: true` (`MAILED_ADDRESSES_NOT_CONFIRMED`).

  **"Sent" means SendGrid accepted it.** `sendEmail` never throws; it returns
  `'sent' | 'queued' | 'lost' | 'disabled'`. Anything that tells a person an email went reads that
  value, never the absence of an error. `email_queue` keeps the body of every refused email, so
  never put a password in an email body.
- **"Use Forgot password" is only true for an account with a Supabase Auth identity** (same id, same
  address).
  - **Why it matters.** Forgot password answers 200 for every address (Round 24), so an account
    without an identity gets a success message and no email, every time, with nothing logged,
    because nothing failed. The silent-catch ratchet cannot see that.
  - **Who creates the identity.** Every path that sends the welcome email creates it first:
    `createAuthAccountFor` inside `registerStudent`, and `createUser` in add-parent and staff bulk
    import.
  - **The check.** `sendWelcomeEmails` confirms it with `getUserById` through the Auth admin API,
    because the C-4a app role cannot read `auth.users`. An account without one is not mailed, is
    named as not sent, and raises `account_cannot_sign_in`. So a recipient carries its `userId`.
  - **What `users` counts.** Production holds 239 `users` rows and 7 Auth identities, because the
    fixtures never had logins. `users` is not a count of people who can sign in
    (`docs/AUDIT-2026-09.md`, L-test-data).
- **`email_queue` keeps a row for 7 days, whatever its status** (`EMAIL_QUEUE_RETENTION_DAYS`; the
  daily `email-queue-retention` job, 03:15 Lagos). Before 2 Oct 2026 nothing deleted one. 1,954
  welcome emails with a password sat there for up to 104 days, and 1,958 of 1,993 rows had lost
  their user, so no school deletion could reach them: the table's only link to a school is
  `to_email` → `users.email` (SECURITY.md Round 29, L-02). Anything new that stores what it sends
  needs its own retention decision in the same commit.
- **An email in Chronix's own voice is built on `services/emailLayout.ts`** (`renderEmail`, since 2 Oct
  2026).
  - **What the layout gives it:** a light page with its own colours, so dark mode cannot hide navy; a
    white 600px card; then the Chronix banner and an HTML "Reach out to us" button to support.
  - **Which emails get it:** only those that speak for Chronix (decided 2 Oct 2026). An email a school
    sends its parents (fee reminders, receipts, notifications) carries no Chronix advertising.
    - **Four use it today:** the principal's onboarding welcome (`onboardingWelcomeEmail.ts`); the staff
      and parent welcome (`welcomeEmailHtml`); the platform announcement; and the Settings test email
      (the last two in `chronixVoiceEmails.ts`).
    - **Everything else stays plain text:** fee reminders, receipts, parent notifications, school
      announcements, payout alerts, the admin reset link, and the platform-admin emails.
    - **A new email needs the same decision.**
  - **The banner:** `apps/web/public/email/banner.png`, served by the web app. Never Supabase Storage,
    which is going private. It is pinned by SHA-256 in `emailLayout.test.ts`. On 2 Oct the version
    carrying a "Set up your school" button was saved under the approved name, and only its size gave it
    away; a changed banner now needs a new hash in the same commit.
  - **Deploy the image first.** The web serves the image and the API names it, so an API deploy that
    references a new image before the web has it sends broken images. Push the image alone (the API's
    watch patterns exclude `apps/web`), confirm the URL, then push the code.
  - **What never carries the banner:** the plain-text part, and a queued retry, because `email_queue`
    has no HTML column. The Supabase password-reset email is a dashboard template, so any banner there
    is added by hand.
- **A test stub of a platform object must mirror production verbatim in every property a
  test depends on** — not "equivalently". `scripts/sql/test_supabase_stubs.sql`'s `auth.uid()`
  called `auth.jwt()` by schema-qualified name where production's names only
  `current_setting()`. Both return the same values, but these are `LANGUAGE sql` functions the
  planner inlines as the current role, so the stub failed with `permission denied for schema
  auth` for any role without USAGE on `auth` — and the C-4a probe measured the stub, not the
  system. Copy bodies from `pg_proc`, and grants too.
- **A local integration run cannot reach a real provider.** `jest.globalSetup.ts` loads `.env` and
  then empties `SENDGRID_API_KEY`, `TERMII_API_KEY`, `PAYSTACK_SECRET_KEY`, `SMS_ENABLED` and
  `SENTRY_DSN`. Emptied, not deleted: suites call `dotenv.config` themselves, and dotenv never
  overwrites a set variable. A test that needs a provider sets a fake key and stubs the call
  (`feesPayout`, `payoutSettings`); `noOutsideWorldKeys.test.ts` guards it. Until 1 Oct 2026 each
  local run sent one real email through production SendGrid (SECURITY.md Round 26).
- That is only safe because both runners refuse a non-local database (`ALLOW_REMOTE_TEST_DB`,
  `ALLOW_REMOTE_TEST_SUPABASE`), so the leftovers land somewhere disposable. **Do not "fix"
  it by letting tests delete audit rows** — a session flag or role that permits it converts
  the invariant into a convention, which is what enforcing it was meant to prevent.
  Migration 048's purge role is not that, and must not become it: it has no login and no members,
  is reachable only through `chronixedu_purge.purge_school_audit_logs`, deletes one whole school,
  and records itself. It exists for `docs/data-deletion-runbook.md`; do not call it from test
  teardown, and never grant anyone membership in `chronixedu_audit_purger`.

## Primary vs secondary (teaching model)

- `users.teacher_mode` is `'class'` (primary: one teacher takes every subject in their
  class) or `'subject'` (secondary). It is set at creation and **immutable** after.
  Any zod schema for it must match the `chronixedu_teacher_mode` enum exactly —
  `'class' | 'subject'`. It drives score-entry UI layout only; it grants no rights.
- **Authorization never depends on `teacher_mode`.** Both modes require a
  `teacher_assignments` row per `(teacher, class, subject, term)`. `classes.form_teacher_id`
  grants attendance and class-comment rights but **not** score entry.
- A primary class teacher therefore needs one assignment per subject. Use
  `POST /:schoolId/teacher-assignments/bulk` (`all_subjects_for_class_ids` expands to
  every active subject; both forms skip existing rows, so re-sending is safe).
- Assignments are **term-scoped**. `POST /:schoolId/teacher-assignments/copy-from-term`
  carries a term's roster into the next one — without it each term starts empty.
- `classes.level` is free text (e.g. "Primary", "JSS", "SSS") and is matched
  **exactly**, so keep it consistent: a typo silently falls back to school-wide config
  rather than erroring. It resolves both `assessment_configs` and grading overrides.
- **A new school has no grading scale, pass mark or assessment structure** until its
  principal sets them in Settings. Neither creation path seeds them (`newSchoolAcademicConfig`
  in `services/schoolService.ts`), and onboarding no longer asks. An unset scale is visibly
  unset: `POST /results/publish` refuses with `409 GRADING_SCALE_NOT_SET`
  (`missing: 'grading_scale'`), resolved per class through `resolveGradingScale`, the
  engine's own resolver, and checked before any other refusal so the reason is never masked.
  Assessment components were already refused visibly (`NO_ASSESSMENT_CONFIG`; scoring reads
  the `assessment_configs` table, not `academic_config.assessment_components`, which nothing
  in scoring reads). Never add a fallback scale: that is the `promotion_cutoff ?? 40` bug
  across every school. DB suites that publish set one explicitly (`setGradingScale` in
  `__db_tests__/helpers.ts`); the seed gives no school a scale.
- **Per-level grading:** `school_settings` holds one row per school, so grading_scale
  and promotion_cutoff are school-wide by default. A school running more than one
  section sets `academic_config.level_overrides[<level>]` to override either field for
  that level. Resolved in `fetchAcademicConfig(schoolId, classId)` and mirrored in
  report-card generation — any new code serving grades must resolve per class, not
  per school.
- **Set from `/settings/level-grading`**, which reads `GET /:schoolId/academic-config/levels`
  (uncached; the levels real classes carry, plus `orphaned_overrides` for keys no class
  has and `near_duplicate_levels` for "JSS"/"jss "-style splits) and saves with the
  existing PATCH. Saving **replaces the whole `level_overrides` map**, so the screen sends
  every override it intends to keep — orphans included, unless removed on purpose.
- Each field is "same as school-wide" (absent) or "its own value" (present). They differ
  even when the numbers match: absent follows later school-wide changes, present is
  pinned (doctrine 8, tested in `levelOverrides.db.test.ts`). Never pre-fill an override
  with the school-wide value — saving it would pin a setting nobody chose to pin.
- `updateAcademicConfig` is an upsert. It was an UPDATE, which matched nothing for a
  school without a `school_settings` row and still answered "updated".

## Platform billing (what a school is charged)

- `platform_subscriptions.amount_naira` is **derived, never written**: the per-student rate
  (`platform_pricing_config.price_per_student_kobo`, a singleton, unset in production until
  Moses sets it on the Subscriptions page) × the school's **billable students**, recomputed by a BEFORE trigger on every
  write (migrations 044, 045). The API refuses `amount_naira` from a caller (400 naming the
  field) rather than ignoring it.
- **A billable student has a `student_classes` row for the school's CURRENT academic
  session, counted once** (`billable_student_count(school_id)`, migration 045; the same
  condition `queries/students.ts` lists students by). 044 counted `students` — everyone ever
  enrolled, a number that only grows — so a school in its fifth year would have paid for five
  cohorts. No graduation feature is needed: a graduate gets no row in the new session and
  falls out at rollover. `COUNT(DISTINCT)` because `student_classes` has **no unique
  constraint on `(student_id, session_id)`** — a mid-session class move leaves two rows.
  That missing constraint is a recorded, un-fixed latent issue (`docs/AUDIT-2026-09.md`).
- **Recompute fires on enrolment and rollover**: `student_classes` INSERT/UPDATE/DELETE and
  `academic_sessions` INSERT/UPDATE OF `is_current`/DELETE. Not on `students` — creating a
  student is not what makes them billable. It is best-effort for exactly one condition, the
  no-rate exception (SQLSTATE `BL001`): an enrolment never fails because billing is not
  configured, and anything else (deadlock, permission) propagates as the fault it is.
- **No current session** (decided in 045): INSERT of a paid plan is refused (`BL002` → 409
  `NO_CURRENT_SESSION`); UPDATE keeps the last computed amount and warns. Zero enrolled with
  a session in place is an honest ₦0.00. `BL001` → 409 `BILLING_RATE_NOT_CONFIGURED`.
- `GET /super-admin/schools/:id/billing-preview` returns the count, the rate and the amount
  from the same function the trigger uses; the create-subscription modal shows it read-only.
- **The rate is set in the product, by the root admin only** (Subscriptions → Per-student rate,
  `PUT /super-admin/pricing`, since 3 Oct 2026). Until then it could only be typed into the database
  by hand, with no record of who set Chronix's price, when, or what it replaced.
  - **One transaction:** lock the table, read the prior value under that lock, write the new one,
    reprice every paid subscription, and write `PRICING_RATE_SET` (prior, new, how many repriced).
  - **Why it reprices:** `amount_naira` is derived only when a subscription row is written. Without
    the repricing, a rate change would leave every subscription showing the old price until
    something touched it.
  - **What it leaves alone:** trials stay ₦0, and a checkout already started keeps its snapshot.
  - **Repricing everyone is a decision for today, not a default** (3 Oct 2026). With no paying
    school, it is right. Once schools pay, the same save rewrites what each already owes mid-term,
    with no effective date and nobody told. Decide grandfathering or an effective date before the
    first rate change that affects a paying school; nothing is built for it.
  - **₦0 is refused** (CHECK `> 0` in 044, and the API). A school that pays nothing belongs on a
    trial plan, not a ₦0 rate.
  - **The confirm step reads out the bill:** each paid school's billable students × rate = total
    (`GET /super-admin/pricing/preview`, the same rows and arithmetic the save uses). Typing 80 for
    800 looks harmless as a rate and obvious as a total, and the ceiling cannot catch it.
  - **"Last set by" is read from the `PRICING_RATE_SET` audit row.** There is no who column, so
    the audit row is the single source for that fact.
  - **A change made outside the product shows on the panel** (`outside_change`, since 3 Oct 2026).
    It shows when the stored rate is newer than, or differs from, the last recorded save, or was
    removed. This is measured, never inferred. Migration 054 moves `updated_at` on every UPDATE, so a
    hand edit cannot leave it behind, and the comparison runs in SQL, at the microsecond. The first
    ₦800 was entered in the SQL editor before the screen's first save, so that save's
    `previous_kobo: 80000` is true (`docs/AUDIT-2026-09.md`).
  - **The ceiling:** the API takes whole kobo (`MAX_PRICE_PER_STUDENT_KOBO`, ₦100,000), to catch a
    naira/kobo slip. The screen converts typed naira with string arithmetic (`lib/money.ts`), never
    `* 100` on a float. Never set the rate by SQL: it would skip the audit and the repricing.
- Tests that need a paid subscription set a rate first (`platform_pricing_config` upsert);
  the fixture's default is production's — none. `partnerRevenue.db.test.ts` and
  `tests/superAdmin.test.ts` choose amounts through rate × enrolment, never a literal.
- **Status follows plan.** `PATCH /subscriptions/:id` derives what a caller leaves unsaid: leaving
  `trial` for a paid plan sets `subscription_status = 'active'`, and trial status on a paid plan is
  refused (`INCONSISTENT_STATUS`). `runTrialExpiryCheck()` never suspends a paid plan — it heals one
  found in trial status (`TRIAL_STATUS_CLEARED_PAID_PLAN`, logged at error). The trial end date is
  inclusive in Africa/Lagos. A manual payment against a suspended subscription reactivates the
  subscription, not the school. All from Chronix High School's 8 Sep suspension — `trialExpiry.db.test.ts`.
- **Plans are trial, premium, enterprise; ₦800 per student per TERM** (decided 30 Sep 2026). One
  list, `PLANS` in `services/planFeatures.ts`; every zod plan enum is `planEnum`; `PLAN_FEATURES` is a
  `Record<Plan, …>` so a plan without a feature decision fails the build. All three get every feature.
  A null/unknown tier passes and logs at error. `billing_cycle` accepts `termly` and defaults to it
  (migration 046). **MRR divides termly by 4** (three terms ÷ twelve months) in `getPlatformRevenue`,
  which is now the only MRR arithmetic — the subscriptions summary and the analytics overview each
  had their own copy, and both counted termly revenue as nothing.
- **A termly subscription's next billing date is derived on read**: `next_term_start(school)`, the
  school's next term start after today (Lagos). Never stored — term dates are editable. The API
  returns it with `next_billing_basis` (`next_term | not_yet_known | not_billed | stored | not_set`),
  because "no future term set yet" is the normal case after onboarding and must not look like a blank.
- **The trial gate** (`runTrialExpiryCheck`, 09:00 Lagos): trial through `trial_ends_at` (inclusive),
  then 14 days of `grace` (full access, in-app countdown), then `read_only` — GETs work, writes under
  `/api/schools/:id` get 423 `SCHOOL_READ_ONLY` (`middleware/requireWritableSubscription.ts`), extras off.
  **Never touches `schools.is_active`** — that is an administrator's decision with its own route. The
  status rides on the cached school row (`findSchoolById`); anything that changes it clears
  `schoolCacheKey(id, 'data')`. `READ_ONLY_WRITE_ALLOWLIST` is where routes that let a school pay go —
  one entry today, the checkout route below. **Name a subscription-payment route with a
  `platform-billing`, `subscription`, `renew` or `checkout` path segment** (`PLATFORM_PAYMENT_PATH`):
  `carveOut.test.ts` walks every write route mounted behind the guard and fails if one matching that
  contract is not carved out. A payment route named otherwise escapes the test, so the name is the
  contract. Recovery: paying online (below), a recorded payment (which also
  moves a trial to premium), extending the trial (status recomputed from the new date), or a PATCH.
  Read-only schools send no fee reminders; queued notifications still deliver in-app and by email,
  without SMS.
- **The gate signs its audit rows with the system account** (migration 053, `config/systemActor.ts`,
  since 2 Oct 2026), never with an admin. It is a `super_admin` row only because
  `platform_audit_logs.platform_admin_id` is a NOT NULL foreign key.
  - **It cannot act as an admin.** It has no Supabase identity and an empty hash. A CHECK keeps it
    inactive, so it fails every `is_active` test that grants a super_admin anything.
  - **The admin screens.** `GET /super-admin/admins` lists it marked `is_system`, and the four admin
    routes answer 404 `SYSTEM_ACCOUNT`.
  - **A missing row alarms.** The gate looks it up on every run and alerts `system_actor_missing`
    if it is gone.
  - **The test fixtures.** The DB seed and the integration fixture both recreate it after the DB
    suite's TRUNCATE. `systemActor.test.ts` keeps both, and the migration, in step.
  - **The rule.** A new automated platform audit write signs with `SYSTEM_ACTOR_ID`. Never select
    "a" super_admin: the unit test fails on `role = 'super_admin' … LIMIT 1`.
  - **It is one more `users` row with no login, on purpose.** It is not a fixture, so never delete it.
- `GET /:schoolId/subscription-status` feeds the staff banner (`components/SubscriptionNotice.tsx`);
  any member of the school may read it, and it answers while read-only.
- **A school pays Chronix online** (migration 052, `routes/platformBilling.ts` +
  `routes/platformBillingPublic.ts`, `/settings/billing` for principal/bursar/super_admin): checkout
  is carved into `READ_ONLY_WRITE_ALLOWLIST` (a lapsed school pays to restore itself without a support
  call), refuses a trial plan (`TRIAL_NOT_BILLABLE`) and a ₦0 amount (`NOTHING_TO_PAY`) before ever
  calling Paystack, and snapshots the amount in kobo on `platform_subscription_payments` at the moment
  of checkout — the billed amount is rate × enrolment *then*, never re-derived, and there is no
  proration or late fee: a payment settles for exactly that amount or not at all, and `next_billing_date`
  simply advances to whatever `next_term_start` is by the time it's read, same as any other read.
- **The trust model, and why it diverges from `routes/feesPublic.ts`.** Fee payments resolve identity
  from Paystack's `metadata` cross-checked against the URL's `:schoolId` — fine when a parent is paying
  into a school's own account. Here the money is Chronix's own revenue, not a tenant's, so identity is
  resolved ONLY from the local `reference`-keyed row this server wrote before calling Paystack
  (`findPendingPaymentForSchool`/`settlePayment` in `db/queries/platformBilling.ts`) — never from the
  webhook or callback's `metadata`, not even cross-checked. `platformBillingFullStack.test.ts` proves
  settlement by reference alone while `metadata.school_id` is deliberately wrong. The webhook
  (`POST /api/schools/platform-billing/webhook`) and callback (`GET .../platform-billing/callback`) carry
  no `:schoolId` segment at all, for the same reason feesPublic's don't take a bearer: Paystack supplies
  neither a session nor a tenant — mounted before the auth chain, same place.
- **No subaccount, no bearer split.** The ERP integration pays schools out through Paystack subaccounts
  because the money is a tenant's; here Chronix is the merchant of record for its own subscription
  revenue, so `initializePaystackTransaction` is called with neither. Copying the ERP's split would
  misroute Chronix's own revenue to whichever subaccount a school happened to have for fee collection.
- **Naira only, at every Paystack verification** (SECURITY.md Round 31). Five places consume
  `verifyPaystackTransaction`:
  - the bursar's record-by-reference in `fees.ts`;
  - the fee callback and webhook in `feesPublic.ts`;
  - the platform-billing callback and webhook.

  Each checks `isNairaPayment`, and a new one must too. Its `amountKobo` is kobo only when the
  currency is NGN. Until 3 Oct 2026 none read the currency. A non-NGN payment is refused, recorded
  nowhere, and alerted (`payment_not_naira`), because the payer overpaid and needs a refund. The
  Paystack account is NGN-only today (3 Oct 2026), so this is defence in depth. It becomes live
  protection if another currency is ever enabled there. A test
  that auto-mocks `paystackService` stubs the check into refusing everything, so keep it real
  (`fees.test.ts`).
- `settlePayment` refuses a verified amount that doesn't match what was snapshotted at checkout
  (`amount_mismatch`, logged and alerted — `config/alerts.ts`'s
  `platform_billing_amount_verification_failed`) rather than trusting Paystack's or the webhook's figure;
  the callback redirects with `?payment=error&reason=amount_mismatch` so the school sees it too.

## A school's data: export and deletion (DPA §11, Terms §22)

- **The legal pages are accepted text** (`legal_terms_accepted_at`). Never edit them to match the
  code; change the code, or raise it with Moses. Public claims elsewhere (`home-page.tsx`) must be
  things the code does today; they were audited against it on 1 Oct 2026 (SECURITY.md Round 21).
- **Export:** principal → Settings → Data Export (`GET /:schoolId/export[/:dataset]`,
  `db/queries/schoolExport.ts`). Every public table is either an `EXPORT_DATASETS` source or in
  `NOT_EXPORTED` with a reason, and `schoolExport.db.test.ts` fails on a table that is neither. A new
  table needs that decision in the same commit.
- **The full export is one zip, files included** (`GET /:schoolId/export/archive`,
  `services/schoolExportArchive.ts`, since 3 Oct 2026). It holds every dataset as CSV, every
  stored file as bytes, and `manifest.csv`.
  - **No links of any kind:** a signed URL in an export expires.
  - **Streamed,** so time-to-first-byte limits never apply and memory stays flat.
  - **Every file is accounted for** in the manifest: `included`, `unreferenced`, `missing_in_storage`
    (a record names it, Storage does not hold it; the export continues) or `read_failed`. Never
    dropped silently.
  - **One list of locations.** The files come from `config/storagePrefixes.json`, the list the
    deletion script reads. `storagePrefixes.test.ts` fails if an upload in `src` writes outside it.
  - **One list of file columns.** The records that name files are `FILE_COLUMNS`; every
    `*_url`/`*_path` column must be there or in `NOT_FILE_COLUMNS` (`schoolExportArchive.db.test.ts`).
  - **Registered before `/:dataset`,** which would read "archive" as a dataset name.
  - **Two audit rows.** `SCHOOL_DATA_EXPORTED` is written before the first byte, so no export leaves
    without a record. `SCHOOL_DATA_EXPORT_COMPLETED` is written after, carrying the manifest's
    counts and the SHA-256 of `manifest.csv`, so a school's copy can be reconciled with the record.
    It is a second row because audit rows cannot be updated.
  - **Generated documents are owned through their path.** A receipt is
    `receipts/<school>/<payment>.pdf` and a transcript `transcripts/<school>/<student>.pdf`, and no
    column points back (`DERIVED_FILES`). The owner is read from the path and looked up, so
    `unreferenced` means that nothing owns the file.
  - **Never trim the export to make a download smaller** (decided 3 Oct 2026). It is the DPA §11 /
    Terms §22 artefact. Leaving results, fees or report cards out would need a `NOT_EXPORTED` reason
    that is false. Someone who wants less downloads one CSV: the page leads with the .zip, then
    lists the single spreadsheets with students, accounts and the audit log first
    (`lib/exportOrder.ts`; `exportOrderKeys.test.ts` checks those keys exist in the API).
- **Deletion:** `apps/api/scripts/delete-school-data.js` and `docs/data-deletion-runbook.md`. Same
  ratchet: every table is in `STEPS` or `NOT_DELETED` (`schoolDeletion.db.test.ts`). A new upload
  path goes in `config/storagePrefixes.json`, shared with the export. A completed run leaves **zero rows** for the school in every
  table, checked inside the transaction, which rolls back otherwise. `audit_logs` goes only through
  migration 048's `chronixedu_purge.purge_school_audit_logs(school, operator)`, decided 1 Oct 2026
  (option (a)). A plain DELETE is still refused, content UPDATE and write-once `processed_at` are
  untouched, and the function is unreachable by anything but the table owner. Each of those is
  tested. `platform_audit_logs` has no triggers, only FKs. The one row a run keeps is the record of
  the purge (`SCHOOL_AUDIT_PURGED`, school id in `metadata`, `target_school_id` NULL so it survives).
  Changing the purge function means acting as `chronixedu_audit_purger` (048 shows how). Never
  widen its grants: functions in `public` default to EXECUTE for PUBLIC, which Supabase serves to
  `anon` over `/rest/v1/rpc`.
- **A school created on production sends real mail**, including the principal's welcome email with a
  working set-password link. A trial uses an address that reaches a mailbox Chronix reads, never an
  invented one (`docs/data-deletion-runbook.md`, "Mail during a production trial").
- **No third party has accepted the Terms or DPA** (1 Oct 2026). Chronix High School is Moses's own
  pilot (`is_demo = true`), not a customer, whatever older commits say. The deletion and backup
  promises bind nobody yet, and must be proven before the first real school signs.
- **A new table therefore needs two decisions in its commit**: exported or not, and deleted or
  not. Each has its own ratchet test, and both fail until the table is classified.
- The homepage's "delete our copy within 90 days" is the same promise as the legal text and was
  **deliberately not reworded** (spec §1: build the process, not new words).
- Migration 047: `validate_assessment_components_total` skips a config that no longer exists,
  so a config and its components can be deleted together. Before 047 no school could be deleted.
  Emptying or unbalancing a live config is still refused.
- **"Auth accounts" in a deletion plan are real logins**: users with an `auth.users` row, read before
  anything changes. It used to count users rows, so a fixture school with 109 users and no logins
  reported "109 Auth accounts", and one network error on a delete with nothing to delete stopped the
  run (2 Oct 2026). The Auth step retries a brief error twice. An error that persists still stops the
  run before the database: a login left behind with no app account is the worse outcome.
- Schools are deleted only by `delete-school-data.js`, which removes their Storage files (through
  the Storage API, before the database step) along with every row. The three orphaned files in
  production came from the old demo seeder, which deleted schools but not their files. Moses
  removed them on 1 Oct 2026, a re-check found 0 orphans, and the seeder itself was deleted the
  same day.

## Partner integration (Chronix ERP)

- `/api/partner/*` is machine-to-machine: gated by `requireErpApiKey` (shared secret in
  `X-API-Key`, compared with `timingSafeEqual` over BYTES — `String.length` counts UTF-16
  units, so a character-length check followed by that comparison throws on a multi-byte
  key and surfaces as a 500). Mounted OUTSIDE `/api/schools`, so none of
  `detectSupportSession → verifyToken → requirePasswordChanged → requireActiveSchool`
  applies — none of it has anything to say about a machine caller.
- **Unset `ERP_INTEGRATION_API_KEY` means the integration is OFF: 503, never 200.** A
  partner route that starts serving because a secret went missing is the failure the
  middleware exists to prevent, and it is tested.
- **The key is set in production and the endpoint has been verified live** (2 Oct 2026):
  `ERP_INTEGRATION_API_KEY` is configured on the API service, and a direct call carrying
  the matching `x-api-key` returned a real `200` with `total_mrr_kobo: 0`, not a refusal.
  The `0` is correct, not a gap — every school in production is a test fixture, demo
  data, or Moses's own `is_demo` pilot (see "What this is"), `getPlatformRevenue`
  excludes demo tenants by design, and there is no real paying school yet. The figure
  moves the moment one pays; nothing further needs building for that to happen.
- Keep partner routes in `routes/partner.ts`, never folded into `superAdmin.ts`. Every
  route in that file carries `...guard` (human session + super_admin); mixing the two
  guards in one file makes "a route drifted past the wrong guard" a one-line mistake in
  either direction.
- **Money crosses that boundary as integer kobo, never naira floats** — doctrine 11 applies
  to a response body as much as to a column. `GET /revenue` returns `total_mrr_kobo` and
  `by_plan[].mrr_kobo`, plus `unit: 'kobo'` in the payload so a consumer cannot read the
  figure as naira and be wrong by 100× with nothing erroring. All of the arithmetic happens
  in Postgres `numeric`: annual plans divide by 12 and round to whole kobo **per
  subscription**, so a plan's MRR is the exact sum of its subscriptions' monthly
  contributions and `total_mrr_kobo` is the exact sum of the plans. The first version did
  `amount / 12` in JS floats and shipped `8.333333333333334` naira for a ₦100/yr plan —
  measured, not theorised. Conversion to naira happens at the display boundary and nowhere
  else.
- Everything served there is aggregate and zero-PII — no school names, no identifiers the
  ERP could use to address an individual. Widening that is a conversation about
  entitlement, not a wider `SELECT`.
- **MRR has one source: `getPlatformRevenue`.** There were two figures before this
  (`/subscriptions/mrr` counted every active subscription; `/analytics/overview` excluded
  demo and suspended schools), agreeing only because no demo school had a subscription.
  The ERP would have made it three. Both routes now read the one function.

## Notices vs announcements (two boards, one each)

- **`announcements`** (migration 010) is the school-wide broadcast: principal-only,
  rate-limited, targeted by **role** (`target_role`), and it fans out in-app notifications
  and email. It cannot target a class.
- **`notices`** (migration 007) is the **class** board: `class_id` nullable, read by
  students at `GET /:schoolId/student/notices`. Class scoping is the only thing it does
  that `announcements` cannot, so keep it that way rather than growing a second broadcast.
- **There is no school-wide notice.** Migration 043 made `class_id` NOT NULL. Keeping one
  gave the product two mechanisms for one intent with materially different delivery — an
  announcement notifies and emails, a school-wide notice appeared on a page and told
  nobody — with nothing at the moment of posting to distinguish them, and both returning
  success. Anything addressed to the whole school is an announcement.
- Posting: a teacher may post to a class they form-teach or are assigned to **this term**
  (`form_teacher_id` OR `isTeacherAssignedToClass`, mirroring `routes/behaviour.ts`).
  Delete carries the identical check — guarding the write and leaving the un-write open is
  half a guard. The case that matters is a teacher on their OWN school's path posting to a
  class they do not teach: `requireSchoolAccess` passes and only the class check stops them.
- `GET /:schoolId/notices` returns `{ notices, classes }` — the postable classes come from
  the same request that lists the notices, so the picker on `/notices` cannot offer a class
  the guard will refuse. Build any future notices UI from that list, not from a roster
  endpoint.
- The staff screen is `/notices`, shared by principals and teachers. One page, because the
  API already decides what each role sees; two would be two places for that to drift.
- **Notices are immutable: create and delete, no edit, so no `updated_at`.** Correction is
  delete + repost, and the form says so before you post. Expiry was considered and
  rejected — an unset `expires_at` cannot be told apart from an author who never thought
  about it (doctrine 9), and the filter it would add to every reader fails by *hiding*
  notices, which nobody reports. Staleness is already handled by
  `ORDER BY created_at DESC LIMIT 20`; what needed a mechanism was removing a notice that
  is *wrong*, and a clock cannot express intent.

## SMS is switched off (1 Oct 2026) — a decision, not a fault

- **Termii is not funded; Moses decided 1 Oct 2026.** SMS is off. Do not "fix" it: no SMS row, no
  Termii call and an `sms_disabled` log line are the system working as intended.
- **The Termii keys stay in Railway on purpose** (`TERMII_API_KEY`, `TERMII_SENDER_ID`; Moses, 1 Oct
  2026: SMS may come back). Do not delete them, and do not read their presence as "SMS is on".
- **The switch is `SMS_ENABLED`**: SMS sends only when it is `true` AND a key is set
  (`isSmsEnabled()` in `services/termiiService.ts`). Unset means off, which is production's state.
  It is not the key, because a key existing answers *what* the key is, not *whether* to send
  (doctrine 8): the first version of this switch keyed off the key's absence, and with the keys kept
  it would have left SMS on against a lapsed account, failing once per parent. The fee-reminder run
  and the notification worker check once per run and skip SMS entirely: no provider call, no
  `notification_logs` row per parent, and **one** `sms_disabled` line per run (per batch that
  delivered something, for the worker; never on an idle poll), whose `reason` says which half is
  missing. Boot logs it once at `warn`. In-app and email delivery are unchanged.
- `sendTermiiSms` answers `'sent' | 'failed' | 'disabled'`. `'disabled'` is not a failure and writes
  no row. A rejected send is logged (`termii_sms_failed`, the status, never the number); it used to
  be logged nowhere.
- **The code stays.** Fund Termii (or a replacement), then set `SMS_ENABLED=true`. Before you
  do, put SMS back in the public claims: `home-page.tsx` and the login page were reworded to "in the
  app and by email" the day it went off. `smsSwitchedOff.db.test.ts` shows both states, enabled first;
  its "off" runs keep the key and leave the switch unset, as production does.
- The feature-adoption count (`/analytics/feature-adoption`) counts `status = 'sent'` only.

## Demo vs customer tenants

- `schools.is_demo` marks a tenant that is not a customer (test fixture, sandbox, sales
  demo). It is orthogonal to `is_active`, which is whether a real school's access is
  currently enabled — a suspended school is still a customer and still counts in
  `total_schools`. Every platform-level count in `superAdmin.ts` filters `is_demo`, and
  the platform school list hides demo tenants unless `include_demo=true`.
- **`is_demo` is stated at creation, never defaulted** (decided 1 Oct 2026, option (1)). Both
  creation paths, `POST /api/schools` (`createSchoolSchema` → `insertSchool(name, slug, isDemo)`)
  and the onboarding wizard's `POST /api/super-admin/onboarding` (`startOnboardingSchema`), require
  `is_demo` as a boolean, with no default, and the wizard's first step offers "customer" or
  "demo/test" with neither preselected. It defaulted to FALSE until then, which is how a typo'd
  test school, `guyg `, was counted as a customer for a day (doctrine 8, applied to the instance
  that produced it). The schema default is dropped in a second step, migration 049, deployed only
  after the code that always supplies the value. Every `INSERT INTO schools`, fixtures and scripts
  included, must name `is_demo`. Both paths also `.trim()` the name (the wizard trims the email
  too), because `guyg ` arrived with a trailing space.
  `schoolCreation.db.test.ts` shows an explicit choice succeeding before it shows an omitted one
  refused. Nothing re-evaluates `is_demo` after creation. The 44 fixture schools were classified
  once, on 26 Sep 2026, by a
  one-off script whose rule was "no user holds an email outside the known test domains"
  — chosen over name matching so a real school called "Testimony Academy" would survive.
- **That rule must never be re-run as a periodic job.** `@students.internal` is in its
  test-domain list, so a real school whose only users were students with generated
  emails would be reclassified as a fixture and vanish from platform totals and the
  super-admin list. A principal with a real address is *not* guaranteed: `insertSchool`
  creates no users, and the onboarding wizard's `POST /complete` treats
  `principalEmail` as optional. If a tenant ever needs classifying again, do it by
  explicit id list.

## Academic calendar

- **Onboarding is five steps** (1 Info, 2 Branding, 3 Calendar, 4 Admin, 5 Review; decided
  1 Oct 2026). Review is `POST /complete`, so the saved steps are 1–4 (`ONBOARDING_SAVED_STEPS`),
  and `/complete` returns `INCOMPLETE_WIZARD` naming the missing ones. They were renumbered
  rather than left with gaps. The one completed session keeps its old keys 1–6 as history,
  which nothing reads, and the one abandoned in-progress session was deleted.
- **The principal's address is the account's only key** (item H, 1 Oct 2026; SECURITY.md Round 27).
  A mistyped address ties the account to a stranger's mailbox, and "Forgot password" sends the reset
  there. So:
  - step 4 requires `email_confirmation` equal to `email` (case- and space-insensitive);
  - the Auth account is created with **no password**, and nothing returns one;
  - `/complete` requires `principal_email_read_back: true`, never defaulted, and checks it after
    `INCOMPLETE_WIZARD` and `NO_PRINCIPAL` so it never masks them. That is the operator's
    statement that they read the address back to the principal by phone. It is recorded as
    `PRINCIPAL_EMAIL_READ_BACK_CONFIRMED` (who, which address, when), and the system cannot check it.
  - `/complete` then makes a Supabase set-password link (`generateLink`, type `recovery`,
    redirect `resetPasswordRedirect()` from `config/appUrls.ts`, shared with forgot-password) BEFORE
    activating anything, and emails it.
  The read-back is the control. The double entry catches typos. The link means nobody relays a
  password, and a wrong address shows at once, because the real principal never gets the link.
  If any of it is ever trimmed, keep the read-back.
- A session has **at most 3 terms**, and onboarding takes **exactly one**: the term the school
  is starting in, which becomes current. Three pre-filled rows made the wizard's optional-row
  check always true, so Next never enabled. Schools rarely know later term dates at sign-up and Nigerian
  calendars shift (holidays, strikes, elections), so the rest are added afterwards
  via `POST /:schoolId/sessions/:sessionId/terms`.
- **Term dates stay editable** via `PATCH /:schoolId/sessions/:sessionId/terms/:termId`
  (principal/super_admin, audited as `TERM_UPDATED`). `is_current` is deliberately not
  editable there — use the activate route, which maintains one-current-term-per-session.
- **Terms in a session must never overlap.** `findTermForDate()` resolves a date with
  `LIMIT 1` and no ordering, so an overlap makes attendance land in an arbitrary term.
  Both the add and edit routes reject overlaps with `409 TERM_DATE_CONFLICT`; onboarding
  applies the same rule through `validateTermRanges`.
- One current session per school and one current term per session are enforced by
  partial unique indexes from migration 001 (`one_current_session`, `one_current_term`).

## Migrations

- Next number after the highest in `migrations/`. Never edit an applied migration.
- Idempotent where possible (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`, find constraints by columns, not name —
  production constraints from 001–023 were partly applied by hand).
- Every new table: `school_id` (if tenant data), `ENABLE ROW LEVEL SECURITY`, a
  `service_role_bypass` policy and a tenant policy, and the policy set must match
  `scripts/sql/rls_policy_inventory.txt` — regenerate it in the same commit or
  `rlsPolicyDrift.db.test.ts` fails. (`tenantIsolation.db.test.ts` checks only that RLS
  is *enabled*; it stayed green through the whole 17-policy drift that 042 fixed.)
- If code starts using a column, a migration must create it. CI rebuilds the schema from scratch.
- **A migration that creates a schema outside `public` must also add it to the drop list in
  `apps/api/jest.db.globalSetup.ts`.** The local rebuild drops only what it names. While it dropped
  `public` alone, 048's `chronixedu_purge` survived between runs, and a revert-to-old-code test run
  measured a stale function instead of the code (SECURITY.md Round 22 L-01).
- A migration that needs a non-superuser's view of privileges (roles, ownership, grants) must be
  tried as a non-superuser. Production's `postgres` has CREATEROLE + BYPASSRLS but is not a
  superuser, and the local test database runs as one, so a superuser run hides permission failures.
  048's first draft failed that way.
- **Regions: the API, web, Redis and the database belong on one continent** (measured 2 Oct 2026).
  - **Where everything is.** Supabase Postgres and its pooler are in `eu-west-1` (Ireland). All
    three Railway services (API, web, Redis) run in EU West (Amsterdam, `europe-west4-drams3a`)
    since 2 Oct 2026; they were in `sfo` (US West). Lagos traffic enters at Cloudflare and Railway's
    `ams1` edge, both in Amsterdam.
  - **What `sfo` cost.** A request went Lagos → Amsterdam → San Francisco, and every query crossed
    back to Ireland. One database round trip was 153 ms (`GET /health` `dbLatencyMs`, a bare
    `SELECT 1` on a warm pool). A sign-in took 2,576 ms in the container (Railway `totalDuration`,
    four real sign-ins), about 17 round trips.
  - **After the move (measured 2 Oct 2026):** `dbLatencyMs` 19 ms; `/health` 25–34 ms in the container
    (was 156–161). A sign-in took 431 ms in the container (851 ms for the first after a deploy). The
    first estimate had said 1–5 ms and 150–350 ms; it assumed a region next to Dublin, which Railway
    does not have.
  - **Why EU West:** it sits next to both `eu-west-1` and the `ams1` edge. Being nearer Nigeria is
    not the reason. Railway has no Irish region, so an Amsterdam–Dublin round trip, typically
    15–25 ms, is the floor.
  - **Redis moves with the API.** Every rate-limit and lockout call goes through `bestEffort` under
    a 500 ms `commandTimeout`. Across the ocean, each one is a ~155 ms round trip.
  - **Redis has a volume.** Changing its region migrates the data, with downtime for the length of
    the migration (Railway docs, "Regions"). Meanwhile rate limits and lockouts fail open,
    `redis_unavailable` alerts, and a support session cannot start. Private networking
    (`redis.railway.internal`) is unaffected by region.
  - **Proving a region:**
    - `GET /health` five times, with `x-health-token`, for `dbLatencyMs`;
    - Railway's http-log `totalDuration` for real `POST /api/auth/login` requests;
    - a new `migration_runs` row;
    - a boot `pg_tls_verified` line naming the bundled CA.

    Supabase's own password hashing is part of every sign-in by design. It is the floor, never
    something to "optimise".
- **Railway auto-deploys from `main`, so pushing IS deploying.** The old runbook order
  ("migrations first, then deploy the API") cannot be honoured by pushing — the code is
  live the moment you push, schema ready or not. Either apply the migration before
  pushing the code that needs it, or set the API service's **Pre-Deploy Command** to
  `npm run migrate:prod` (`node dist/scripts/migrate.js` — plain JS, so it needs no
  ts-node; it exits non-zero on failure, which aborts the deploy). Set it on the API
  service only: the web service has no `dist/scripts`. **Railway runs commands from
  `/app`, not from the service directory** — which is why `build` and `start` both begin
  `cd apps/api &&`. The command currently set is `cd apps/api && npm run migrate:prod`;
  a root-level `migrate:prod` delegate also exists, so the bare form works too.
- **Railway's build command must be `npm ci && npm run build --workspace=@chronixedu/api`.**
  It was `cd apps/api && npm install && npm run build` — `npm install` inside a workspace
  member bypasses the root lockfile, so production builds were not reproducible and could
  drift from what CI tested. Verified by clean install into an empty tree: `npm ci` then
  the workspace build produces `dist/scripts/migrate.js`, `dist/migrations` (36 .sql) and
  `dist/templates`. Scoping the install with `--workspace` is not worth it — npm still
  materialises the whole hoisted tree, so it installs the same 730 packages either way.
  The build also reads the root `tsconfig.base.json`, so it needs the repo root present.
- **The web service mirrors it since 30 Sep 2026:** root directory `/` (the repo root), build
  `npm ci && npm run build --workspace=@chronixedu/web`, start
  `cd apps/web && npm start -- -p ${PORT:-3000} -H 0.0.0.0`, watch `/apps/web/**`,
  `/package.json`, `/package-lock.json`. It had `rootDirectory: /apps/web` with
  `npm install --prefer-offline=false && npm run build` — the lockfile was not even visible
  to the build, so every web deploy resolved dependencies afresh against ranges.
  `apps/web/tsconfig.json` does not extend `tsconfig.base.json`, so that is not a web build
  input. Verified from a clean clone (`npm ci`, then the workspace build produced
  `apps/web/.next`) before the change, and the start command was run locally in that exact
  form (`/login` and `/settings` 200). The first build under it was made deliberately — the
  commit carrying this note — and checked for `SUCCESS` *and* the login page loading: a build
  that succeeds with a broken start command is the one failure that takes the site down
  rather than leaving the old deploy serving. A Railway *redeploy* cannot test this config:
  it reuses the old image, whose files sit at `/` rather than under `apps/web`.
- **The Supabase CA ships in the repo at `apps/api/certs/supabase-ca.crt`**, is copied
  into `dist/certs` by the build, and is the DEFAULT — `PGSSLROOTCERT` only overrides it.
  So a deploy is TLS-verified without setting any variable, and `pg_tls_verified` is
  logged at boot with the resolved path. `apps/api/certs/**` must be in the API service's
  watch patterns — already satisfied by the existing `/apps/api/**` pattern, so nothing
  to add; the patterns that needed adding were the ones OUTSIDE `apps/api`.
- **The bundled CA expires 26 Apr 2031** (Supabase Root 2021 CA). Because `resolveSsl()`
  fails closed, expiry or an early Supabase rotation is an outage at boot, not a degraded
  connection. Every `pg_tls_verified` line therefore carries `notAfter` and `daysLeft`,
  and `pg_tls_ca_expiring` warns inside 90 days (`CA_EXPIRY_WARN_DAYS`). `inspectCa` is
  pure and takes an injected clock so both branches are tested against the CA that
  actually ships. A calendar entry exists as the backup; the log is the mechanism.
- Every migrate run, including a no-op, writes a row to `migration_runs` (resolved dir,
  file count, applied count, `RAILWAY_GIT_COMMIT_SHA`). A pre-deploy step that silently
  never executes looks exactly like a healthy one from outside, and the migrate output DOES appear in the deployment's deploy log (seen on the 11:33 and 16:16 UTC deploys of 30 Sep 2026) — but only to someone who can read that log, so the row that cannot be absent quietly is the proof: `SELECT * FROM migration_runs
  ORDER BY id DESC LIMIT 5` is how you confirm the gate actually ran.
- **Before changing the build, ask: what does this build read, and is all of it
  watched?** Three separate inputs were found living outside the watched path, each
  only when something forced it into the open — `migrations/`, the root manifests
  (made build-critical by the switch to `npm ci`), and `tsconfig.base.json`. An
  unwatched build input does not fail loudly: the change simply sits in the repo,
  absent from the deployed image, until an unrelated commit drags it in. The current
  set is `/apps/api/**`, `/migrations/**`, `/package.json`, `/package-lock.json`,
  `/tsconfig.base.json`. Anything new the build reads goes in that list in the same
  commit that makes it a dependency.
- **The API service's `build.watchPatterns` must include `/migrations/**`.** It is
  scoped to `/apps/api/**`, and `migrations/` sits at the repo root — so a commit that
  adds only a migration triggers no build and no deploy, which is exactly the commit a
  pre-deploy migrate gate exists to catch.
- `npm run build` copies `migrations/` into `dist/migrations`, and the runner prefers
  that copy, so the migrate step does not depend on the repo root surviving a
  service-scoped container build. The runner requires the directory to actually contain
  `.sql` files — an empty `apps/api/src/migrations/` exists in some working copies, and
  matching it made the runner report success after reading zero files.
- **Clear the Pre-Deploy Command before rolling back past `aead53b`.** A rollback runs
  an OLD image, and images built before `aead53b` have no `dist/migrations` — their
  bundled `migrate.js` still uses the unverified repo-root path. With the gate on, such
  a rollback either fails pre-deploy and is blocked, or behaves unknown. Rollback is
  what you reach for when something is already on fire. This stops mattering once every
  rollback candidate is post-`aead53b`.

## Definition of done

A change is done when all of these pass locally:

```bash
npm run lint
node scripts/audit-gate.js               # CI's security gate; needs the network (npm audit)
npx tsc -p apps/api/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npm run test:unit                       # mocked, no DB
# The two DB-backed runners take their targets from the SHELL. The integration setup loads
# apps/api/.env but never overrides a variable already set — and .env's DATABASE_URL is
# production, which its guard refuses; .env's TEST_DATABASE_URL points at port 54322 (the
# ERP stack's Postgres), not the container below. Mirror ci.yml, then run in this order —
# test:db rebuilds the schema that test:integration:local seeds into:
export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/chronixedu_test
export DATABASE_URL=$TEST_DATABASE_URL SUPABASE_URL=http://127.0.0.1:54321        SUPABASE_SERVICE_ROLE_KEY=local-placeholder SUPABASE_PUBLISHABLE_KEY=local-placeholder
npm run test:db                         # 40 suites, 377 passed + 2 skipped (3 Oct 2026), ~90s with durability off (below)
                                        # on a starved host, one process per suite — see "flaky local run" below
npm run test:integration:local -- --forceExit   # 22 suites, 187 passed + 7 skipped (Auth-dependent; the setup says why)
(cd apps/web && npx next build)
```

Run the local test database with durability off, as CI does — the seed truncates ~45
tables per test and flushing them is most of the suite's time (225–242s → 99s measured):

```bash
docker run -d --name chronixedu-test -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=chronixedu_test   -p 5432:5432 postgres:16 -c fsync=off -c synchronous_commit=off -c full_page_writes=off
```

Only on a disposable container. `jest.db.globalSetup.ts` deliberately does NOT set these:
its guard checks for a local host and a `_test` name, which a developer's native Postgres
would also pass — and `fsync` is server-wide, so it would switch off crash safety for every
other database on that server.

**Not every DB-suite flake is contention: read the constraint name.** CI run 189 (1 Oct 2026) failed
with `duplicate key … "users_support_code_key"` in the shared seed, in a suite the commit never
touched. It looked like doctrine 15 and was not. It was a random six-digit `support_code` colliding,
and production had the same exposure, growing with every user (migration 050,
`supportCode.db.test.ts`). A leftover row collides on its id; a random value collides on its own
constraint. The code space is six digits, 900,000 accounts platform-wide. Assignment stops after
100 draws with SQLSTATE `SC001` (migration 051) instead of looping, so `SC001` means "widen the
code", never "raise the bound".

**A flaky local run on Windows is not evidence about the code until the host is ruled out.**
On 28 Sep 2026 a run of connection timeouts, `ECONNRESET` and two native `0xC0000409`
crashes of the jest process was traced — after three wrong attributions — to the host
paging (15.4 GB RAM, 36 GB committed): Postgres idle, TCP connects fast under load, and
the client's own 10s timer firing through event-loop stalls. Check free memory before
chasing a flake. A run that prints NO summary line is not a pass either: treat it as failed and keep the whole log (a scripted `test:db` printed nothing on 30 Sep 2026 and the cause was not recorded — `docs/AUDIT-2026-09.md`). The ERP project's Supabase stack runs in the same Docker VM; stop it when
you are not using it. Under about 2.5 GB free, a single Jest process running all DB suites dies
partway, whether started by npm or directly (1 Oct 2026). Run each suite in its own process,
capturing every exit code and `Tests:` line, and do not count a suite with no summary:
`for f in src/__db_tests__/*.db.test.ts; do npx jest -c jest.db.config.js --runInBand "$f"; done`
(from `apps/api`).

**The security gate carries a dated exception list** (`scripts/audit-allowlist.json`, enforced by
`scripts/audit-gate.js` as CI's third step). It exists because a bare `npm audit --audit-level=critical`
sat red on every commit for five weeks after two critical advisories landed on `next`, stopped the
workflow before lint and every test, and so stopped reporting anything. An entry is honoured only
while it is still reported as critical, unexpired, and its stated precondition holds; adding a
`remotePatterns`, `domains` or `loader` to `apps/web/next.config.js` therefore fails CI until the AVIF
exception is re-decided. Do not extend an `expires` date by habit — upgrade, or re-justify it.

Workflow/data-integrity changes need a DB test in `apps/api/src/__db_tests__/`
that **fails on the old code**. Never point any test at production: both test
setups refuse non-local hosts, and `ALLOW_REMOTE_TEST_DB=<host>` exists only for
a deliberate staging run.

## Spec drift (PDFs in docs/spec are historical)

| Spec says | Reality |
|---|---|
| Supabase Auth JWT with custom claims; RLS enforces isolation | Custom HS256 JWT; RLS is defence in depth only (doctrine 2) |
| `result_status` draft→submitted→approved→published per student | Two-level workflow (doctrine 5) |
| Hosting: Vercel (web) | Railway (web and api) |
| Firebase Cloud Messaging | Not used. In-app notifications (polled every 60s) + SendGrid; Termii SMS switched off 1 Oct 2026 |
| `packages/shared`, Axios, Zustand | Not present. Types live per app; `fetch` wrapper in `lib/api.ts` |
| Launch 7 Sep 2025 (PRD) | Launched 7 Sep 2026 |
| Flat subscription tiers | trial / basic / premium / enterprise, per student per term |
| Rule S5: `app.use('/api/auth', rateLimit({ windowMs: 60000, max: 5 }))` | **Amended 30 Sep 2026.** That counted *successful* logins, so a principal's sixth correct password in 35s was refused, and it keyed the whole staff room's router as one client. `POST /login` now counts failed attempts only (`rl:login:`; 20/min since Round 19); the other `/api/auth` routes keep counting everything, because forgot-password answers 200 for every email. The guessing control is the per-email lockout in `routes/auth.ts`. Do not "restore" S5 — see `docs/rate-limit-remediation.md`, SECURITY.md Round 17 |
| Migrations live in `apps/api/src/migrations/` (Agent File folder structure) | Repo-root `migrations/`. The empty `apps/api/src/migrations/` left behind was a fossil of this and silently matched the migrate runner's directory lookup — deleted |
