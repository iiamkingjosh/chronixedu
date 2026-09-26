# Chronix Edu — Changelog

## Result Review for Principals (2026-09-26)

### Principals can now see the results they are approving
- The approval screen showed only subject name, teacher name and how many students had been scored. Approving from that confirmed the teacher had finished entering marks — it said nothing about whether the marks were right.
- **Review results** on a class now opens every student against every subject, with weighted totals, grades, overall average and position.
- **View scores** on a subject row opens that subject's marks as the teacher entered them, broken down by CA1, CA2 and Exam.
- Both views are read-only. Approve, publish and return are unchanged and still live on the approval screen.
- A dash means no score has been entered, which is deliberately shown differently from a zero.

### The Students list shows academic standing to principals
- Principals now see each student's term average and class position alongside the existing details, drawn from the same figures as the approval screen and report cards.
- Registrars see the list exactly as before — the academic columns are principal-only.
- Students with no scores yet still appear, with a dash rather than a zero, and the page works normally when no term is active.

## Platform Analytics Accuracy (2026-09-26)

### Platform totals now count customers, not database rows
- The super-admin overview counted every school and every student in the database, including tenants created by automated tests. Total schools, total students, new schools this month, trials and MRR were all affected.
- These figures now exclude non-customer tenants (test fixtures, sandbox and sales-demo schools), which are marked separately from suspended schools.
- A suspended school still counts towards total schools — it is a customer whose access is paused — but no longer counts towards students, trials or revenue.
- The platform school list hides demo tenants by default, so they no longer appear on screen when the dashboard is shown to a prospective school.

### Audit logs cannot be deleted or edited
- The audit trail was documented as append-only, but nothing in the database enforced it — the application's own connection could have removed or rewritten entries.
- Deleting or updating an audit entry is now rejected by the database itself.

## Account Creation & Credentials (2026-09-26)

### Newly registered students and parents can now actually log in
- Registering a student created its login record **without creating the matching sign-in account**, so neither the student nor any parent created alongside them could ever log in — the password simply never worked.
- The parent side was the visible failure: parents were emailed a welcome message with credentials that could not work.
- Registration now creates the sign-in account first and links the record to it. Bulk import is fixed the same way.
- Accounts created before this change are affected and need to be re-registered.

### Every imported account now gets its own password
- Bulk import previously gave every account — students, parents and staff, at every school — the same fixed temporary password. Anyone who knew it could sign into a freshly imported staff account before its owner did.
- Each account now gets its own randomly generated temporary password, still requiring a change at first login.
- Staff and parents receive theirs by email. Students, who have no email address of their own, now have theirs printed in the import results spreadsheet, which asks you to hand them out privately and then delete the file.
- Bulk import is somewhat slower as a result — around 3.4 seconds per row, so a full 50-row file takes roughly three minutes to commit.

## Role-by-Role Audit — Result Visibility, Attendance & Behaviour Guards (2026-09-23)

### Results are no longer visible before publication
- Parents and students previously saw scores as soon as a teacher entered them — before subject submission, principal approval, or publication. The four routes that serve score data to those roles fetched the result status but never actually checked it.
- All four now require the term's result to be **published** before any score, average, grade or class position is returned (`routes/parent.ts`, `routes/student.ts`).
- Both results pages now show a clear "Results not published yet" message explaining that scores appear once the school has finished marking, instead of rendering an empty table.
- Previously only the report-card *PDF* was gated, which made the workflow look complete when it wasn't.

### Attendance history is restricted to a teacher's own classes
- Marking attendance always required being the class's form teacher or assigned to it; *viewing* a class's roster and 30-day history did not — any teacher could read any class in the school.
- Both attendance read endpoints now apply the same relationship check (`routes/attendance.ts`). Principals and super-admins are unaffected.

### Behaviour incidents must cite a class the student is actually in
- Logging an incident verified that the student and the class each existed, but never that the student was *in* that class, nor that the reporting teacher taught it — and a suspension notifies the parent immediately.
- Now validates the student's enrollment and requires the reporter to be the form teacher or assigned to that class for the current term (`routes/behaviour.ts`).

### Principal dashboard: at-risk students and teacher activity
- Two fully-built backend capabilities had no UI and were invisible to principals. The dashboard now shows students below the promotion cut-off (with how far short they are) and per-teacher submission progress with last score-entry date.

### Onboarding no longer demands the whole year's calendar upfront
- Sign-up previously required all three terms with exact start and end dates — six date fields a school usually can't answer months ahead.
- Onboarding now asks only for the term the school is actually starting in; the others are marked optional and can be left blank.
- Remaining terms are added later from Settings → Academic Structure.

### Term dates can now be corrected when the calendar shifts
- There was previously **no way to edit a term's dates** anywhere in the product — only to mark one current. A holiday change, strike or election that moved the calendar could only be fixed with direct database access.
- Principals can now edit a term's name and dates, with the change recorded in the audit log.
- Terms are also now prevented from overlapping each other (on both adding and editing). Overlapping terms previously caused attendance to be filed against an arbitrary one of them.

### Primary schools: assign a class teacher to a whole class at once
- A primary class teacher takes every subject in their class, but assignments could only be created one subject at a time — a dozen separate saves per class, and again for every class.
- A teacher can now be assigned to every subject in one or more classes in a single action. Re-running it is safe; existing assignments are left alone.

### Teaching assignments carry forward to the next term
- Assignments belong to a term, and nothing copied them forward — so every school rebuilt its entire teaching roster by hand at the start of every term.
- A term's roster can now be copied into another term, skipping anything already there.

### Schools running both a primary and a secondary section can grade them differently
- The grading scale and promotion cut-off were stored once per school, so both sections were forced to share one pass mark.
- A school can now override the grading scale and/or pass mark per class level, falling back to the school-wide values where no override is set. Applies to results, the at-risk list and report cards alike.

### Fixed: creating a teacher via the admin API could fail
- The account-creation endpoint accepted a teaching mode value the database doesn't recognise, which failed on save. It now accepts exactly the two valid modes.

### Parents can now see school notices
- Announcements could already target parents and did reach them as in-app notifications, but there was no page listing them — the only way to read one was the notification popup. Added a Notices page to the parent menu.

### Timetables now say *why* they're empty
- A blank timetable previously looked the same whether the school hadn't activated a term or simply hadn't built the schedule yet. The teacher page even said "No active academic term, or no periods have been assigned to you yet" because the two cases were indistinguishable.
- Teacher, student and principal timetables now state which it is, so a principal knows when the fix is to activate the term.

### Smaller corrections
- Viewing an older term's results showed the student's *current* class name next to the correct scores; it now shows the class they were actually in that term.
- Students can no longer open another class's timetable by changing the address (staff are unaffected).
- Parent and student sections now redirect other roles to their own home page instead of rendering an empty shell.
- School-wide announcements are now recorded in the audit log.
- A parent can no longer be linked to a student from a different school, enforced in the database itself.

### Teacher signature on class comments
- The class-comments page fetched the teacher's signature from an admin-only endpoint, silently received a permission error, and showed nothing. Added a self-scoped `users/me` endpoint and pointed the page at it.

## Staff & Payment Bulk Import, Data-Integrity Fixes, Security Hardening (2026-08-31 — 2026-09-17)

### Staff Bulk Import
- Fourth bulk-import feature (after Students, Roster): `.xlsx`/`.csv` upload → preview → commit for staff accounts (`services/staffBulkImportParser.ts`, `staffBulkImportValidation.ts`), with a shared fixed temp password, welcome emails, and a downloadable results file (`services/staffBulkImportResults.ts`).
- Entry point added to the Users settings page.
- Follow-up fix: surfaced real per-row failure reasons instead of a generic message, hashed the shared password once per request instead of per row, and guarded against a forged/stale commit status being trusted from the client.

### Bulk Payment Import (reconciling pre-Paystack payments)
- Lets a bursar bulk-record payments collected before a school went live on Paystack, without needing a corresponding online transaction: `.xlsx`/`.csv` upload → preview → commit, matching students by admission number (`services/bulkPaymentImportParser.ts`, `bulkPaymentImportValidation.ts`, `bulkPaymentImportResults.ts`).
- Entry point added to the Fee Structures page.
- Running-balance validation tracks each student's remaining invoice balance in-file-order so multiple rows for the same student are checked cumulatively, not independently.
- Follow-up fixes: an unrelated validation error on a row no longer incorrectly consumes that student's running balance; audit-log failures are now decoupled from payment outcome so a logging failure can never retroactively mark an already-successful payment as failed; date cells use UTC getters to avoid timezone-induced off-by-one-day shifts.
- The same results-file/audit-log safety fix was backported to the three earlier bulk-import features (Students, Roster, Staff) for consistency.

### Data-integrity fix: `students.admission_no` uniqueness scope
- **File:** `migrations/027_fix_admission_no_uniqueness_scope.sql`
- The column had a *global* `UNIQUE` constraint, but the admission-number generator only scanned the current school's students when picking the next number — two schools sharing the same prefix (e.g. the default "SCH") could collide. Changed to a composite `UNIQUE(school_id, admission_no)` constraint, scoping uniqueness correctly per school.

### Security hardening
- See `SECURITY.md` Round 8 (2026-09-01) and Round 9 (2026-09-17) for full detail: forced-password-change enforcement (`requirePasswordChanged` middleware), a Paystack double-delivery bug that could surface as a false payment failure or silently lose a real payment, a payout-settings step-up brute-force lockout, a `paystack_reference` schema-tightening fix, and a scores-subsystem fix preventing a teacher from writing grades for unenrolled students or silently overwriting another subject's score.

### Reliability fixes
- `apps/api/src/db/client.ts` now handles idle pooled-connection errors (e.g. Supabase's PgBouncer reclaiming a connection) via `pool.on('error', ...)` instead of letting the unhandled event crash the whole API process.
- Added a public `/health/ping` liveness endpoint (no auth, no sensitive detail) alongside the existing token-gated `/health`, for uptime monitors whose plan doesn't support custom request headers.

### Academic operations fixes
- **Term activation was completely missing** — `terms.is_current` could never be set to `TRUE` anywhere in the system (sessions had an Activate flow; terms never did), so every feature defaulting to "the active term" (timetable, score entry, attendance, results) silently broke for every school. Added `PATCH /:schoolId/sessions/:sessionId/terms/:termId/activate` and the matching Activate button on the Academic Structure settings page.
- Principal dashboard stats (staff/student counts) were cached with nothing invalidating the cache on user creation — a newly created user wouldn't appear until the 5-minute TTL expired. Migrated to the shared `cacheService` so staff/student creation (single and bulk) can invalidate it on write.
- Report cards ignored a school's own "Primary Colour" identity setting (which already worked elsewhere, e.g. the settings nav preview) — both the classic and modern Handlebars templates hardcoded their own accent color. Wired `identity_config.primary_colour` through into a `--brand-color` CSS variable in both templates.
- The Roster bulk-import template had no explanation of its columns (in particular "Stream," an optional subject-track subdivision) — added an Instructions sheet with worked examples and per-column notes, with no change to headers/sheet names so existing filled-in templates still import correctly.
- Two workflows that already worked end-to-end had no way for a principal to discover them: added a "Students" link to the principal nav (parent-linking happens on the student-creation form, previously only reachable via the registrar nav) and a direct link to Settings → Roster in the post-creation success banner when a teacher is created (class/subject assignment is a separate step). The student bulk-import results screen now also displays each created student's admission number on screen (previously only in the downloadable file).

## Payout, Plan Gating & Bulk Import (2026-08-06 — 2026-08-20)

### School Payout via Paystack Subaccounts
- Parent fee payments now settle directly to each school's own bank account via
  Paystack Subaccounts (`services/paystackService.ts`: `listBanks`,
  `resolveBankAccount`, `createPaystackSubaccount`), at 0% platform fee —
  Chronix's account receives nothing from these transactions. Full design in
  `docs/superpowers/specs/2026-08-06-school-payout-subaccounts-design.md`.
- New bursar/principal-facing payout settings page (bank select → resolve →
  confirm) at `GET/POST/PUT /:schoolId/settings/payout`, with a narrow access
  carve-out so bursars reach only this page under Settings.
- Fee payment initiation is blocked with `PAYOUT_NOT_CONFIGURED` until a
  school's payout is active, replacing the previous single pooled Paystack
  account.
- 3-way fraud alert fires on every bank-details change (create or update):
  the principal (email + SMS), the school's own official email, and the
  platform root admin — each an independent, timestamped record.
- Super-admin schools list gained a Payout status column (Active/Pending).
- Hardening after a whole-branch review: an active payout config is no
  longer wiped on a transient Paystack failure; bank changes made during a
  support session are attributed to the real admin, not the impersonated
  bursar; `GET /onboarding/:sessionId` no longer leaks the unmasked account
  number; added cross-tenant isolation tests.
- Payout error responses moved from `502` to `424 Failed Dependency` after
  confirming Railway's edge replaces `5xx` bodies with a generic error page,
  destroying the real Paystack error message before it reached the browser.

### Plan-Based Feature Gating & Pricing
- Plan enum simplified from `trial/basic/professional/enterprise` to
  `trial/basic/premium/enterprise`. Full design in
  `docs/superpowers/specs/2026-08-06-plan-based-feature-gating-design.md`.
- `schools.subscription_tier` is now kept in sync with `platform_subscriptions`
  on every create/update and included in the login JWT payload.
- New `planIncludesFeature`/`schoolAllowsFeature` module gates SMS sending,
  online Paystack fee collection (payout settings + initiate), and the
  analytics dashboard to Premium/trial/enterprise — Basic-tier schools keep
  results, attendance, timetable, portals, messaging, and fee invoicing/manual
  payment recording. Basic-tier fee reminders skip the SMS leg but still send
  in-app + email.
- Corresponding UI (payout nav, pay-now button, analytics link) is hidden for
  Basic-tier schools.
- Homepage `#pricing` rewritten around the new per-student pricing: Basic
  ₦400/student/term, Premium ₦600/student/term (recommended), Enterprise at
  custom pricing — replacing the old 4-tier monthly/annual grid.

### Subscriptions & Fees
- New trial subscriptions default to 30 days.
- `amount_naira = 0` is now accepted when creating a trial subscription
  (paid plans still require a positive amount).
- Manual (cash/bank-transfer) invoice payments now go through the same
  overpayment guard the Paystack-initiated flow already had — recording a
  payment larger than the outstanding balance now returns
  `400 AMOUNT_EXCEEDS_BALANCE` instead of silently pushing the balance
  negative.

### Student & Parent Bulk Import
- New upload → preview → commit flow for registering many students (with up
  to two parents each) from a single `.xlsx`/`.csv` file, reusing the same
  registration logic as the single-student form. Full design in
  `docs/superpowers/specs/2026-08-19-student-bulk-import-design.md`.
- Every bulk-imported account gets the fixed temporary password
  `Password2$` and is forced to change it on first login; a downloadable
  results file lists what was created.
- Row cap lowered from 200 to 50 per file after measuring real per-row
  commit time; the JSON body limit was raised so a full 50-row commit
  payload can actually reach the server.
- Follow-up hardening: uploaded file content is validated instead of ever
  500ing on a malformed file, field-length limits now match single
  registration, emails are lowercased, name-less rows are no longer
  silently dropped, row numbering and duplicate detection were fixed, and
  the downloadable template's example row was made unmistakably a
  placeholder.
- Entry points added on the Students page and a dedicated import page.

### Roster Bulk Import
- Same upload → preview → commit pattern extended to Roster setup: a single
  `.xlsx` workbook (no CSV — three sheets don't fit a flat format) with
  Classes, Subjects, and Teacher Assignments sheets, capped at 300 rows
  combined. Full design in
  `docs/superpowers/specs/2026-08-20-roster-bulk-import-design.md`.
- Teacher Assignment rows resolve only against pre-existing classes/subjects
  (not ones created earlier in the same file), committed in a fixed
  Classes → Subjects → Assignments order.
- Entry points added on the Roster settings page and a dedicated import page.
- Roster settings page itself gained a Settings nav link — the page existed
  and worked but had no way to discover it from the sidebar.

### Support Sessions & Account Management
- Every user now has a short 6-digit support code (shown under their email
  in the sidebar) so a platform admin can start a support (impersonation)
  session by code instead of a raw UUID.
- Starting a support session now actually swaps the admin into the target
  user's session and dashboard (with an "Exit Support Session" banner to
  restore their own login), instead of just displaying an unused JWT in a
  modal.
- New `PATCH /:schoolId/users/:userId/email` lets `super_admin` reassign a
  school account to a new hire's email (e.g. principal handover), rotating
  the Supabase and local password together in one transaction so the
  departing holder can't log in as the new owner.

### Messaging, Notifications & Onboarding Polish
- An open inbox/thread now polls for new messages every 12s instead of
  requiring a manual reload.
- Stopped sending a redundant email on every new in-app message.
- Bursar and registrar are now valid announcement/messaging audiences and
  contacts, with their own read-only announcements view and Messages pages.
- School onboarding's assessment-components step (previously a fixed
  CA1/CA2/Mid-Term/Exam list) now supports adding/removing rows.
- Outgoing email now shows "Chronix Edu" as the sender name instead of the
  raw from-address.
- Timetable builder gained tap-to-place support for touchscreens, alongside
  existing mouse drag-and-drop.

### Housekeeping
- Several CI/test-infrastructure fixes: a stale duplicate root Jest config
  that skipped fixture seeding, tests silently depending on leaked mock
  state or stale fixtures, a broadened `seed-test-user` dev/test guard, and
  an unblocked CI unit-test job that no longer needs real DB/Supabase
  credentials.

---

## Phase 3 — Payments, Messaging, Analytics & Timetable (2026-06)

### Fees & Payments (Paystack)
- Per-term fee structures (line items) and per-student invoices (`migrations/011_add_fees_tables.sql`).
- Payment recording for `cash`, `bank_transfer`, `paystack`, and `waiver` methods.
- Live Paystack transaction initialization, verification, and webhook signature
  verification (`services/paystackService.ts`).
- PDF receipt generation (`services/receiptService.ts`).
- Outstanding-balance and collection-summary reporting for bursars/principals.
- Weekly automated fee reminder cron — in-app notification + email (SendGrid) +
  SMS (Termii), throttled per parent (`services/feeReminderService.ts`).

### SMS Notifications (Termii)
- `services/termiiService.ts` sends transactional SMS via the Termii API, using
  a per-school sender name from `school_settings.notification_config` with a
  configurable fallback (`TERMII_SENDER_ID`).
- SMS delivery is logged and rate-limited per recipient via
  `db/queries/notificationLogs.ts`.

### Analytics Dashboards (Recharts)
- Nightly analytics snapshot cron computing overall performance, subject
  performance, attendance summary, and fee collection per school/term
  (`services/analyticsService.ts`, `migrations/012_add_analytics_tables.sql`).
- `/api/schools/:schoolId/analytics` exposes the latest snapshot plus
  trend deltas against the previous snapshot for Recharts-based dashboards.

### Timetable (@dnd-kit)
- Drag-and-drop weekly timetable builder backed by
  `migrations/013_add_timetable.sql`, with class- and teacher-clash detection
  (`db/queries/timetable.ts`, `routes/timetable.ts`).
- Class and teacher timetable views for staff and teachers.

---

## Phase 3 Hardening — Backend Reliability & Observability (2026-06-12)

### Startup environment validation (E2)
- `apps/api/src/config/env.ts` validates all required environment variables
  with Zod on boot (`DATABASE_URL`, `JWT_SECRET`, Supabase keys, etc.) and
  throws a single combined error listing every missing/invalid var. Wired
  into `index.ts` before the Express app is created.

### Query performance — new indexes (migration 015)
- Ran `EXPLAIN ANALYZE` against the live database for the dashboard,
  teacher-activity, and audit-log queries used by
  `db/queries/dashboard.ts` / `db/queries/auditLog.ts`.
- Added composite indexes for filter predicates that lacked coverage
  (`migrations/015_add_dashboard_query_indexes.sql`):
  - `scores (school_id, term_id)`
  - `users (school_id, role)`
  - `audit_logs (school_id, action_type, created_at DESC)`

### Structured JSON error format (C6)
- Audited every route for the `{ success: true, data }` /
  `{ success: false, error: { code, message } }` envelope.
- `apps/api/src/routes/auth.ts` and `apps/api/src/middleware/auth.ts` were the
  only non-conforming files — `create-user`, `login`, `seed-test-user`, and
  `test-role` now return the standard envelope, and `verifyToken` /
  `requireRole` now return `{ success: false, error: { code: 'UNAUTHORIZED' | 'FORBIDDEN', message } }`.
- Updated `apps/web/app/(auth)/login/page.tsx` and `apps/web/app/providers.tsx`
  for the new `/api/auth/login` response shape (`data.access_token`,
  `data.user`).

### Rate limiting (S5)
- Extracted `generalRateLimiter` (100 req/min) and `authRateLimiter`
  (5 req/min) into `apps/api/src/middleware/rateLimit.ts` with a shared
  `handler` so 429 responses also use the standard error envelope
  (`RATE_LIMIT_EXCEEDED`).

### Winston structured logging (C4)
- Added `apps/api/src/config/logger.ts` (JSON-formatted Winston logger,
  `debug` outside production / `info` in production).
- Added `apps/api/src/middleware/requestLogger.ts`, logging method, path,
  status, and duration for every request.
- `errorHandler` now logs every unhandled error (message, stack, method,
  path) via the logger before responding.
- Replaced all remaining `console.log` / `console.error` calls across
  `apps/api/src` (auth routes, analytics/fee-reminder/notification cron jobs,
  email and Termii services) with structured `logger.debug` / `logger.error`
  calls.
