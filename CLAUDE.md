# CLAUDE.md — Chronix Edu agent rules

Read this before every task. It describes the system **as built** (September 2026).
Where the PDFs in `docs/spec/` disagree with this file, this file wins — see
"Spec drift" at the bottom. Audit history: `docs/AUDIT-2026-09.md`, `SECURITY.md`.

## What this is

Multi-tenant school management SaaS for Nigerian private schools. No real paying
client is live yet — every school currently in the database is either a test
fixture (created by an integration test, never cleaned up — see `L-test-data`
in `docs/AUDIT-2026-09.md`) or demo/sandbox data. `apps/api/scripts/seed-child-prime.js`
seeds a fictional "Child Prime Onyx School" with made-up Nigerian names and
gmail.com parent emails for demos/sales — it is NOT a real customer record, and
running it **wipes every school and every Supabase Auth user first**. Treat
this repo's "production" database as pre-launch: no real student, parent, or
payment data exists in it as of 18 Sep 2026. Monorepo, npm workspaces:

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
   choice — that it had not chosen one. The check is mechanical: ask whether a field
   answers *what* or *whether*, and record the second separately when you need it.
9. **Advisory output is indistinguishable from no output once you have decided to push.**
   The corollary to doctrine 7: verifying what a guard *does* is useless if the guard only
   reports. The lint scripts therefore carry `--max-warnings` pinned to the current count
   (api 1, web 5), so an existing warning stays tolerated and a NEW one fails at the
   moment of introduction rather than scrolling past in pre-commit hook output.
   Proof this was needed: a new unused-import warning was introduced and pushed in
   86b0a18 with the hook reporting it the whole time.
   **It freezes the count; it does not shrink it.** Nothing decrements the number, so
   those six warnings are now permanent-by-default rather than accumulating — strictly
   better, and a different claim. Going down takes someone fixing a warning *and*
   lowering the number in the same commit, and nothing here prompts that. Never raise
   them: a raise is the ratchet being removed, one notch at a time.
10. **Every sensitive write is audited** (`logAudit`, or an `audit_logs` insert in
   the same transaction for batch writes): scores (old + new), result status,
   settings, payments, support-session actions. `audit_logs` has no DELETE.
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
  (SECURITY.md Round 18). Rate-limit keys, lockout keys and the audit `ip_address` column all
  go through `clientIp`. A new `req.ip` reader is a regression; `audit_logs.ip_address` rows
  before 30 Sep 2026 hold proxy addresses.
- **Redis is best-effort on the request path** (SECURITY.md Round 19, decided: fail open).
  The shared client has `commandTimeout: 500`; every read or write of a limit, lockout or
  cache goes through `bestEffort(event, op)` in `middleware/rateLimit.ts`, which logs and
  returns `undefined`, and all five limiters carry `passOnStoreError: true`. A bare
  `await redis.x()` on a request path is a regression: it turns a Redis outage back into
  500s and 503s. The exceptions are the support-session token store and blacklist writers
  in `superAdmin.ts`. While Redis is down both brute-force controls are off and nothing
  alarms — open item in `docs/AUDIT-2026-09.md`.
- Login: Supabase `signInWithPassword` verifies the password; the API then signs
  its **own** HS256 JWT (`JWT_SECRET`, 1h) with `user_id, school_id, role, email,
  title, must_change_password, subscription_tier`. Supabase-issued tokens are
  not used anywhere else.
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
- Web: all HTTP through `lib/api.ts` (`apiFetch`, `apiUpload`, `apiFetchBlob`). Forms use React Hook Form + zod.
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
- **Never write a queue row or an audit row fire-and-forget, and never swallow its failure.**
  `audit_logs` doubles as the notification queue (`*_NOTIFICATION_QUEUED`), so a write that
  outlives its request, or ends in `.catch(() => {})`, can lose a parent notification while
  the response says it was queued — which `POST /results/publish` did. Await it; if the
  write can fail without undoing the operation, log the failure and make the response say
  so (`notifications_queued: false`). Found because an un-awaited INSERT deadlocked with
  the next test's seed.
- **A test stub of a platform object must mirror production verbatim in every property a
  test depends on** — not "equivalently". `scripts/sql/test_supabase_stubs.sql`'s `auth.uid()`
  called `auth.jwt()` by schema-qualified name where production's names only
  `current_setting()`. Both return the same values, but these are `LANGUAGE sql` functions the
  planner inlines as the current role, so the stub failed with `permission denied for schema
  auth` for any role without USAGE on `auth` — and the C-4a probe measured the stub, not the
  system. Copy bodies from `pg_proc`, and grants too.
- That is only safe because both runners refuse a non-local database (`ALLOW_REMOTE_TEST_DB`,
  `ALLOW_REMOTE_TEST_SUPABASE`), so the leftovers land somewhere disposable. **Do not "fix"
  it by letting tests delete audit rows** — a session flag or role that permits it converts
  the invariant into a convention, which is what enforcing it was meant to prevent.

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

## Demo vs customer tenants

- `schools.is_demo` marks a tenant that is not a customer (test fixture, sandbox, sales
  demo). It is orthogonal to `is_active`, which is whether a real school's access is
  currently enabled — a suspended school is still a customer and still counts in
  `total_schools`. Every platform-level count in `superAdmin.ts` filters `is_demo`, and
  the platform school list hides demo tenants unless `include_demo=true`.
- **`is_demo` defaults to FALSE, so a new school is a customer from birth.** Nothing
  re-evaluates it. The 44 fixture schools were classified once, on 26 Sep 2026, by a
  one-off script whose rule was "no user holds an email outside the known test domains"
  — chosen over name matching so a real school called "Testimony Academy" would survive.
- **That rule must never be re-run as a periodic job.** `@students.internal` is in its
  test-domain list, so a real school whose only users were students with generated
  emails would be reclassified as a fixture and vanish from platform totals and the
  super-admin list. A principal with a real address is *not* guaranteed: `createSchool`
  inserts name and slug only, and the onboarding wizard's `POST /complete` treats
  `principalEmail` as optional. If a tenant ever needs classifying again, do it by
  explicit id list.

## Academic calendar

- A session has **at most 3 terms**, but onboarding only requires the one the school
  is starting in. Schools rarely know later term dates at sign-up and Nigerian
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
  never executes looks exactly like a healthy one from outside, and Railway does not
  surface pre-deploy output in the API's log streams — so `SELECT * FROM migration_runs
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
- **Clear the Pre-Deploy Command before rolling back past `e0eb457`.** A rollback runs
  an OLD image, and images built before `e0eb457` have no `dist/migrations` — their
  bundled `migrate.js` still uses the unverified repo-root path. With the gate on, such
  a rollback either fails pre-deploy and is blocked, or behaves unknown. Rollback is
  what you reach for when something is already on fire. This stops mattering once every
  rollback candidate is post-`e0eb457`.

## Definition of done

A change is done when all of these pass locally:

```bash
npm run lint
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
npm run test:db                         # 22 suites, 219 passed + 2 skipped, ~90s with durability off (below)
npm run test:integration:local -- --forceExit   # 21 suites, 186 passed + 7 skipped (Auth-dependent; the setup says why)
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

**A flaky local run on Windows is not evidence about the code until the host is ruled out.**
On 28 Sep 2026 a run of connection timeouts, `ECONNRESET` and two native `0xC0000409`
crashes of the jest process was traced — after three wrong attributions — to the host
paging (15.4 GB RAM, 36 GB committed): Postgres idle, TCP connects fast under load, and
the client's own 10s timer firing through event-loop stalls. Check free memory before
chasing a flake. The ERP project's Supabase stack runs in the same Docker VM; stop it when
you are not using it.

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
| Firebase Cloud Messaging | Not used. In-app notifications (polled every 60s) + SendGrid + Termii |
| `packages/shared`, Axios, Zustand | Not present. Types live per app; `fetch` wrapper in `lib/api.ts` |
| Launch 7 Sep 2025 (PRD) | Launched 7 Sep 2026 |
| Flat subscription tiers | trial / basic / premium / enterprise, per student per term |
| Rule S5: `app.use('/api/auth', rateLimit({ windowMs: 60000, max: 5 }))` | **Amended 30 Sep 2026.** That counted *successful* logins, so a principal's sixth correct password in 35s was refused, and it keyed the whole staff room's router as one client. `POST /login` now counts failed attempts only (`rl:login:`; 20/min since Round 19); the other `/api/auth` routes keep counting everything, because forgot-password answers 200 for every email. The guessing control is the per-email lockout in `routes/auth.ts`. Do not "restore" S5 — see `docs/rate-limit-remediation.md`, SECURITY.md Round 17 |
| Migrations live in `apps/api/src/migrations/` (Agent File folder structure) | Repo-root `migrations/`. The empty `apps/api/src/migrations/` left behind was a fossil of this and silently matched the migrate runner's directory lookup — deleted |
