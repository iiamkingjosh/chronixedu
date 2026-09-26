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
8. **Every sensitive write is audited** (`logAudit`, or an `audit_logs` insert in
   the same transaction for batch writes): scores (old + new), result status,
   settings, payments, support-session actions. `audit_logs` has no DELETE.
9. **Money:** Postgres `numeric(12,2)` naira today. Never add/subtract money in
   JS floats — do arithmetic in SQL, or convert to integer kobo first. New money
   columns should be `bigint` kobo.
10. **Crons run through `runExclusive(name, fn)`** (Postgres advisory lock) and
   schedule with `{ timezone: CRON_TIMEZONE }` (Africa/Lagos). Any user-facing
   time-of-day logic on the server uses Africa/Lagos, not server time.
11. **The service role key never leaves the API** and is never logged, not even a prefix.

## Auth (as built)

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
- Record security fixes in `SECURITY.md` (next round, existing format) and
  user-visible changes in `docs/CHANGELOG.md`, in the same PR as the change.
- New integration tests in `apps/api/tests/` must delete the rows they create in `afterAll`,
  with one family of exceptions that migrations 036/037 created. `audit_logs` is
  append-only at the database level, so a test cannot delete its audit rows — and because
  `audit_logs` holds FKs to both `users` and `schools`, it cannot delete an audited **user**
  or their **school** either. Teardown therefore guards those deletes:
  `AND id NOT IN (SELECT user_id FROM audit_logs WHERE user_id IS NOT NULL)` and the
  `school_id` equivalent, leaving the audited ones behind.
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
  `service_role_bypass` policy and a tenant policy. `tenantIsolation.db.test.ts` fails otherwise.
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
npm run test:db                         # needs TEST_DATABASE_URL=postgres://…/chronixedu_test (local)
npm run test:integration:local          # same local DB; runs after test:db
(cd apps/web && npx next build)
```

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
| Migrations live in `apps/api/src/migrations/` (Agent File folder structure) | Repo-root `migrations/`. The empty `apps/api/src/migrations/` left behind was a fossil of this and silently matched the migrate runner's directory lookup — deleted |
