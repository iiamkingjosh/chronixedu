# Roles audit fixes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding of the 8 Oct 2026 roles audit, and build the one table of who can do what.

**Architecture:** Nine batches, most serious first. Each batch is one or more commits, each with tests that fail on
today's code, then the full Definition-of-done gate. Batches 1–8 fix behaviour inside today's permission
model; batch 9 replaces that model with the capability table from the spec, which also fixes the findings that
are role/screen mismatches. Nothing is pushed without Moses's go.

**Tech Stack:** Express + TypeScript API (`apps/api`), Next.js 14 web (`apps/web`), PostgreSQL migrations
(`migrations/`), Jest (unit, DB, integration suites).

**Spec:** the audit report (https://claude.ai/artifact/2bPhbKs7kAGJND8nhFXc2p, findings with file:line) and
`docs/superpowers/specs/2026-10-08-roles-permissions-design.md` (the table; batch 9).

## Moses's decisions (8 Oct 2026), verbatim

- Items 1–4 of "Fix first": "Fix that", "Fix too", "Fix", "Fix that (suggest a fix and fix it)". "Fix all findings."
- Bursar and the payout account: "Only view to avoid changes".
- Onboarding starts a trial automatically: "Yes".
- Parents see past terms' results, report cards and invoices: "Yes please".
- Parents see the class notices teachers post: "Yes".
- One parent account for children in two schools: "No".
- Settings → Notifications: "Make it work".
- Single new staff accounts: "Yes welcome email" (no password on screen).

## Global Constraints

- CLAUDE.md is binding: tenant from the JWT (doctrine 1), validate the target (3), published-only to parents
  and students (5), no "default = chosen" (8), money in integer kobo (11), crons through `runExclusive` (12),
  every sensitive write audited with the prior value read (10), no swallowed errors (alerts ratchet),
  `clientIp(req)` for every audit row, Redis best-effort on request paths.
- Each fix has a test that fails on today's code. Workflow/data-integrity fixes get a DB test.
- Lint warnings stay at the pinned counts (api 1, web 4).
- A new table needs its export and deletion decisions, an RLS policy and the inventory regenerated, in its commit.
- Security fixes recorded in SECURITY.md (Round 40), user-visible changes in docs/CHANGELOG.md, in the same
  commit.
- Never push without Moses's go; production is read only, counts only.

## Review Focus

1. **A term created mid-way, when the previous term's scores already exist.** Copying the assessment structure
   forward must copy only the structure, never scores, and never touch the earlier term's configs. Test in 2.2.
2. **A student with two `student_classes` rows in one session** (no unique constraint). Results notifications
   must reach each parent once, not twice. Test in 1.1.
3. **A parent with two children in the same school.** The term picker and the child switcher must keep each
   child's data apart. Test in 6.1/6.2.
4. **Redis down** during the new fee-reminder cooldown and the attendance thresholds. Fail open, logged, never a
   500. Test in 5.3 and 7.4.
5. **A school with nothing set up** opening the checklist, the grading page and the score sheet: each says what
   is missing, nothing pretends to be set. Test in 2.1 and 3.4.

---

## Batch 1 — Notifications reach people; messages can be answered

### Task 1.1: Results notifications reach parents (Fix first 1)

**Files:** Modify `apps/api/src/services/notificationWorker.ts`; Test `apps/api/src/__db_tests__/notificationDelivery.db.test.ts` (new).

**Interfaces:** Produces `studentIdsOf(newValue): string[]` (internal to the worker).

- [ ] Step 1: failing DB test. Seed a class with two students and their parents; publish through
  `POST /results/publish`; run `processNotificationQueue()`; assert each parent has exactly one in-app
  notification of type `results_published` and one email attempt; assert the queue row is processed. A second
  case: a student with two `student_classes` rows in the session still yields one notification per parent.
  A third: a behaviour row (single `student_id`) still delivers, as today.
- [ ] Step 2: run it; expect 0 notifications (today's worker reads only `new_value.student_id`).
- [ ] Step 3: implement. In `processRow`, read the students as
  ```ts
  const ids = Array.isArray(row.new_value?.student_ids) ? row.new_value.student_ids : [];
  const studentIds = [...new Set([...ids, ...(row.new_value?.student_id ? [row.new_value.student_id] : [])])];
  ```
  then load parents with `WHERE ps.student_id = ANY($1)`, de-duplicated by `(parent_id, student_id)`, and
  deliver one notification per parent per child.
- [ ] Step 4: run; pass. Run `notificationQueue.db.test.ts` too.
- [ ] Step 5: commit with SECURITY.md/CHANGELOG notes (not a security fix; CHANGELOG only).

### Task 1.2: Teachers can answer students; a reply stays in its thread (Fix first 2, audit S5)

**Files:** Modify `apps/api/src/db/queries/messages.ts` (teacher contacts), `apps/api/src/routes/messages.ts`
(thread recipient check); Test `apps/api/src/__db_tests__/messagingContacts.db.test.ts` (new).

- [ ] Step 1: failing tests: (a) a student messages their class's teacher; the teacher replies → 201;
  (b) a teacher messages a student in a class they do not teach this term → 403; (c) a reply with a `thread_id`
  to someone who is not in that thread → 403, and the third party cannot read the thread.
- [ ] Step 2: run; (a) and (c) fail today.
- [ ] Step 3: teacher contacts add students enrolled this session in classes the teacher is assigned to this
  term or form-teaches; the send route requires, when `thread_id` is given, that the recipient already took part
  in that thread.
- [ ] Step 4–5: pass; commit (SECURITY.md Round 40 L-01 for the thread fix).

### Task 1.3: Contact lists use this term and active people (audit, parent N)

**Files:** Modify `apps/api/src/db/queries/messages.ts`; Test in `messagingContacts.db.test.ts`.

- [ ] Steps: failing tests — a parent's contacts exclude a teacher assigned only last term and a deactivated
  teacher, and include the child's form teacher with no assignment row; implement with the current term and
  `is_active`; pass; commit.

## Batch 2 — Grading, pass mark and assessment structure

### Task 2.1: School-wide Grading sets the pass mark; nothing pretends to be set (Fix first 3, audit F8)

**Files:** Modify `apps/web/app/(dashboard)/settings/grading-scale/page.tsx`; Test
`apps/api/src/__db_tests__/settingsAudit.db.test.ts` (pass-mark save audited with prior) and a web unit test
for the empty-state helper `apps/web/lib/gradingDefaults.ts` (new).

- [ ] Steps: failing tests (the PATCH saves `promotion_cutoff` from this page's payload and audits it; the
  page's initial form for a school with no scale is empty and marked "Not set"); implement a Pass mark field
  (blank means not set; never pre-filled) and replace the pre-filled bands with a "Start from a common scale"
  button that fills the form without saving; pass; commit.

### Task 2.2: A new term gets the last term's assessment structure; teachers are told when there is none (Fix first 4)

Suggested fix (Moses asked for one): **copy forward automatically when a term is created**, because a school
almost always assesses the same way term to term; a principal can still change the new term's copy before any
score is entered. Plus **a "Copy from previous term" button** for a term that already exists without one, and
**a clear message** on the score sheet and in the error text.

**Files:** Modify `apps/api/src/routes/sessions.ts` (term create), `apps/api/src/db/queries/assessmentConfig.ts`
(`copyAssessmentConfigs(schoolId, fromTermId, toTermId, client)`), `apps/api/src/routes/assessmentConfig.ts`
(`POST /:schoolId/assessment-config/copy-from-term`), `apps/api/src/routes/scores.ts` and `results.ts` (message),
`apps/web/app/(dashboard)/settings/assessment-config/page.tsx` (button),
`apps/web/app/(dashboard)/teacher/scores/page.tsx` (empty state); Test
`apps/api/src/__db_tests__/assessmentTermCopy.db.test.ts` (new).

**Interfaces:** Produces `copyAssessmentConfigs(...) : Promise<number>` (configs copied).

- [ ] Steps: failing tests — creating term 2 copies term 1's configs and components (same weights), audited
  `ASSESSMENT_CONFIG_COPIED`; scores of term 1 are untouched; the copy endpoint refuses a target term that
  already has configs (409); score entry with none says "Assessment for this term isn't set up yet. Ask the
  principal to set it up in Settings → Assessment Config."; implement in one transaction; pass; commit.

### Task 2.3: An assessment structure cannot change results behind anyone's back (audit F4)

**Files:** Modify `apps/api/src/routes/assessmentConfig.ts`; Test in `assessmentTermCopy.db.test.ts`.

- [ ] Steps: failing tests — adding a config for a term whose matching scope already has scores → 409
  `SCORES_EXIST`; POST audited; `DELETE` allowed only with no scores, audited; implement; pass; commit.

### Task 2.4: Analytics uses the school's pass mark (audit F14) and the promotion line uses the last term (F15)

**Files:** Modify `apps/api/src/db/queries/analytics.ts`, `apps/web/components/charts/PrincipalAnalyticsCharts.tsx`,
`apps/api/src/services/reportCardService.ts`; Tests: unit for `computePromotionStatus`, DB for analytics pass rate.

- [ ] Steps: failing tests — pass rate uses the resolved pass mark (per level) and is "not available" when
  none is set; a session's last term by start date gets the promotion line whatever its name; implement; pass;
  commit.

## Batch 3 — Onboarding and setup

### Task 3.1: The calendar step can be saved twice (audit F2)

**Files:** Modify `apps/api/src/routes/superAdmin.ts` (step 3); Test in `onboardingFiveSteps.db.test.ts`.

- [ ] Steps: failing test — save step 3, then again with new dates → 200 and one session, one term, both
  updated; implement as update-if-exists in one transaction; pass; commit.

### Task 3.2: Onboarding starts a trial (decision)

**Files:** Modify `apps/api/src/routes/superAdmin.ts` (`/complete`); Test in `onboardingFiveSteps.db.test.ts`.

- [ ] Steps: failing test — completing onboarding creates a `trial` subscription, status `trial`,
  `trial_ends_at` 30 days on (Lagos, inclusive, `DEFAULT_TRIAL_LENGTH_DAYS`), audited `SUBSCRIPTION_CREATED`
  signed by the operator; a school that already has a subscription is not given a second; implement; pass;
  commit.

### Task 3.3: The school address is saved (audit B1)

**Files:** Modify `apps/api/src/routes/schools.ts` (identity schema), `apps/web/app/(dashboard)/settings/identity/page.tsx`;
Test `apps/api/src/__db_tests__/schoolIdentity.db.test.ts` (new).

- [ ] Steps: failing test — PATCH identity with an address stores it and receipts read it; clearing the motto
  stores empty; implement; pass; commit.

### Task 3.4: A setup checklist tells the principal what is missing (audit section 3)

**Files:** Create `apps/api/src/services/setupStatus.ts`, route `GET /:schoolId/setup-status` in
`apps/api/src/routes/schools.ts`, `apps/web/components/SetupChecklist.tsx` on the principal dashboard; Test
`apps/api/src/__db_tests__/setupStatus.db.test.ts` (new).

**Interfaces:** Produces `getSetupStatus(schoolId): Promise<Array<{ key: string; done: boolean; detail: string; href: string }>>`.

- [ ] Steps: failing tests for a bare school (every item missing, each naming its page) and a complete one (all
  done), and for "the current term ended on <date>: activate the next term"; items: grading scale, pass mark,
  assessment for this term, classes, subjects, teachers, teacher assignments this term, students in a class,
  fee lines this term, payout account; implement; pass; commit.

### Task 3.5: Term dates editable on screen; roster carried to a new term (audit G3, F6)

**Files:** Modify `settings/academic-structure/page.tsx` (edit dates, existing PATCH), `settings/roster/page.tsx`
("Copy from last term", "Assign a class teacher every subject", existing routes); Tests: the routes are covered;
add web unit tests for any new request builders.

- [ ] Steps: build the controls, each with confirmation and the API's message on refusal; run the routes' DB
  tests; commit.

### Task 3.6: Class levels and deletions (audit section 5, F17)

**Files:** Modify `apps/api/src/routes/roster.ts`, `apps/api/src/db/queries/roster.ts`; Test
`apps/api/src/__db_tests__/rosterIntegrity.db.test.ts` (new).

- [ ] Steps: failing tests — a level is trimmed; a near-duplicate of an existing level ("Jss" vs "JSS") is
  refused with the existing spelling named; changing a class's level with overrides or configs keyed to the old
  one returns a warning the screen shows; deleting a class or subject still used by attendance, fees, timetable
  or results answers 409 naming the use, never 500; implement; pass; commit.

### Task 3.7: Attendance tells a teacher when today's term is not active (audit F16)

**Files:** Modify `apps/api/src/routes/attendance.ts`; Test in an attendance DB test.

- [ ] Steps: failing test — marking attendance on a date inside a term that is not the active one, by a teacher
  with no assignment in it, answers 409 `TERM_NOT_ACTIVE` naming the term, not 403 `NOT_ASSIGNED`; the checklist
  (3.4) shows the ended term; implement; pass; commit.

## Batch 4 — Students and the registrar

### Task 4.1: Registration links only a parent of this school (audit, item 5; decision: one school per parent)

**Files:** Modify `apps/api/src/db/queries/students.ts` (`registerStudent`), `apps/api/src/services/bulkImportValidation.ts`;
Test `apps/api/src/__db_tests__/registrationParents.db.test.ts` (new).

- [ ] Steps: failing tests — an existing staff email as parent → 409 `NOT_A_PARENT`; another school's parent →
  409 `PARENT_AT_ANOTHER_SCHOOL` ("This email belongs to a parent account at another school. One parent account
  belongs to one school."), and no login was created; bulk import refuses another school's parent; implement the
  checks before any login is made; pass; commit (SECURITY.md Round 40).

### Task 4.2: Registration's class is checked; no silent drop (audit S1, inconsistency)

**Files:** Modify `registerStudent`, `apps/api/src/routes/students.ts`; Test in `registrationParents.db.test.ts`.

- [ ] Steps: failing tests — another school's class → 404; a class given when the school has no current session →
  409 `NO_CURRENT_SESSION`; implement; pass; commit.

### Task 4.3: Promotions work as they say (audit item 8, F10)

**Files:** Modify `apps/api/src/db/queries/students.ts` (`listStudents` session filter), `apps/api/src/routes/students.ts`
(promote-bulk validates `from_session_id`, locks the student), `apps/web/app/(dashboard)/registrar/promotions/page.tsx`;
Test `apps/api/src/__db_tests__/promotions.db.test.ts` (new).

- [ ] Steps: failing tests — listing a session returns only students enrolled in it; promote-bulk refuses a
  student not in the from-session; two promotions at once give one enrolment; the page: "Promoted" needs a new
  class (blank by default), "Repeat" keeps the class; implement; pass; commit.

### Task 4.4: Bulk import gives classes; registrar sees the term; photos; transcripts (audit gaps)

**Files:** Modify the bulk import parser/validator/commit (optional class column, by class name), import page
(50 rows, finish screen lists students without a class with Assign Class), students page header (current session
and term), student profile (photo upload), `apps/api/src/services/transcriptService.ts` (published only); Tests:
DB tests for import with a class and transcript filtering.

- [ ] Steps: failing tests; implement; pass; commit.

### Task 4.5: Student changes are audited (audit S3)

**Files:** Modify `apps/api/src/routes/students.ts`; Test in an audit DB test.

- [ ] Steps: failing test — registration, bio edit, photo and add-parent each write an audit row with the
  caller's address (bio edit with the prior values); implement; pass; commit.

## Batch 5 — Fees and the bursar

### Task 5.1: Bulk payment import in kobo (audit, doctrine 11)

**Files:** Modify `apps/api/src/services/bulkPaymentImportValidation.ts`; Test its unit test.

- [ ] Steps: failing tests — ₦100,000 + ₦9.59 against ₦100,009.59 is accepted; "10.123" and "1e3" are refused;
  implement with `nairaToKobo` string parsing and integer sums; pass; commit.

### Task 5.2: Fee lines can be corrected; invoices never silently ₦0 (audit F7)

**Files:** Modify `apps/api/src/routes/fees.ts`, `apps/api/src/db/queries/fees.ts`,
`apps/web/app/(dashboard)/bursar/fee-structures/page.tsx`; Test `apps/api/src/__db_tests__/feeLines.db.test.ts` (new).

- [ ] Steps: failing tests — edit and delete a fee line (audited, prior value); a duplicate line (same term,
  class and name) → 409; "Copy from last term"; Generate with no mandatory lines → 409 `NO_FEE_LINES`; Generate is
  audited; amounts are naira strings to kobo; the term and class belong to the school; implement; pass; commit.

### Task 5.3: Record a Paystack payment by reference on screen; collection by class this session; reminders confirmed

**Files:** Modify `bursar/invoices/page.tsx` (method option), `db/queries/fees.ts:540` (session), reminders route
(confirmation on screen, audit row, one run per school per hour, Redis best-effort) and page text; Tests: DB tests
for the summary and the reminder cooldown and audit, and a unit test that a Redis failure on the cooldown check
logs and lets the run proceed (never a 500).

- [ ] Steps: failing tests; implement; pass; commit.

### Task 5.4: Payment history shows refunds; waivers carry a reason; stale comment (audit notes)

**Files:** Modify parent fees page and bursar Payments modal, waiver path (reason required, audited), comment at
`bursar/invoices/page.tsx:250`; Tests: DB test for waiver reason.

- [ ] Steps: failing tests; implement; pass; commit.

## Batch 6 — Parents and students

### Task 6.1: Switching children never shows the previous child's data (audit item 9)

**Files:** Modify `apps/web/app/(parent)/parent/dashboard/page.tsx`, `results/page.tsx`, `attendance/page.tsx`;
Test: a web unit test for the child-scoped loader in `apps/web/lib/childScopedData.ts` (new).

- [ ] Steps: failing test — with two children in the same school, a slow response for the first child that
  arrives after switching to the second is discarded, and state clears on switch and on error; implement;
  pass; commit.

### Task 6.2: Parents see past terms (decision)

**Files:** Parent Results, Attendance, Fees and report-card download get a term picker (the routes already take
`term_id`); `GET /:schoolId/parent/terms` (terms of the school, newest first) in `routes/parent.ts`; Test
`apps/api/src/__db_tests__/parentPastTerms.db.test.ts` (new).

- [ ] Steps: failing tests — a parent reads last term's published results, report card, attendance and invoice;
  unpublished last-term results stay hidden (doctrine 5); implement; pass; commit.

### Task 6.3: Parents see their children's class notices (decision)

**Files:** `GET /:schoolId/parent/students/:studentId/notices` in `routes/parent.ts` (linked child, the child's
current class), parent Notices page shows announcements and class notices; Test
`apps/api/src/__db_tests__/parentNotices.db.test.ts` (new).

- [ ] Steps: failing tests — a parent sees notices of their child's class and not of another class; implement;
  pass; commit.

### Task 6.4: Students: this session's class only, clear empty states, upload limit (audit student findings)

**Files:** `apps/api/src/routes/student.ts` (no current term → 200 with `term: null`, class from the current
session), student Home, Timetable, Assignments, Notices pages (no class / no term messages), assignment upload
(413 "Files can be up to 5 MB"; the form states the limit), attendance "—" when nothing marked; Tests: DB tests
for the student dashboard without a term and a student only enrolled last session.

- [ ] Steps: failing tests; implement; pass; commit.

### Task 6.5: Parent wording and dead links (audit notes)

**Files:** read-only (423) message for parents; report-card button shows an error when signing fails.

- [ ] Steps: implement with a web unit test where logic is extracted; commit.

## Batch 7 — Staff, principal tools, notification settings

### Task 7.1: Reset Password tells the truth (audit B3)

**Files:** Modify `apps/api/src/routes/users.ts` (read the send result; link with `resetPasswordRedirect()`;
students without a real email get a new temporary password shown once instead, as registration does), Users page;
Test `apps/api/src/__db_tests__/staffPasswordReset.db.test.ts` (new).

- [ ] Steps: failing tests; implement; pass; commit.

### Task 7.2: Attendance alerts can be resolved (audit G2)

**Files:** `PATCH /:schoolId/attendance/alerts/:id/resolve` (principal, audited), principal Attendance page button;
Test in an attendance DB test: a resolved student can alert again.

- [ ] Steps: failing tests; implement; pass; commit.

### Task 7.3: Teachers upload their own signature (audit G5)

**Files:** `apps/api/src/routes/users.ts` (self allowed before the principal-only gate, for this route only); Test.

- [ ] Steps: failing test — a teacher uploads their own signature (201) and not another's (403); implement; pass; commit.

### Task 7.4: Settings → Notifications works (decision)

**Files:** `apps/api/src/routes/attendance.ts` and `db/queries/attendance.ts` (threshold and window from
`notification_config`, defaults stated on the page when unset), `services/notificationWorker.ts` and
`routes/announcements.ts` (per-event in-app/email toggles), Notifications page (SMS column explained as off);
Test `apps/api/src/__db_tests__/notificationSettings.db.test.ts` (new).

- [ ] Steps: failing tests — a school's threshold of 2 in 5 days raises an alert at the second absence; turning
  off email for results stops the email and keeps in-app; Redis down changes nothing here; implement; pass; commit.

### Task 7.5: A new staff account gets the welcome email, never a password on screen (decision)

**Files:** `apps/api/src/routes/users.ts` (`POST /users` creates the Auth account with no password and sends
`sendWelcomeEmails`, like bulk import), Users page; Test in `staffOnlyAccounts.db.test.ts`.

- [ ] Steps: failing test — the response has no `temp_password` and says whether the welcome email went;
  implement; pass; commit (SECURITY.md Round 40).

### Task 7.6: No principal can lock the school out; staff changes audited; ids checked (audit S2, S3, S1)

**Files:** `routes/users.ts` (cannot deactivate yourself or the last active principal; cache write through
`bestEffort`), `routes/roster.ts`, `routes/timetable.ts`, `routes/sessions.ts`, `routes/assessmentConfig.ts`
(audit rows; class, subject and term ids checked against the school), `routes/analytics.ts` (term id validated);
Tests in DB suites per route.

- [ ] Steps: failing tests; implement; pass; commit (SECURITY.md Round 40).

## Batch 8 — Class lists that ignore the session (audit F5)

### Task 8.1: Every "who is in this class" asks "this session"

**Files:** `db/queries/attendance.ts:54-63,190-203,278-290`, `db/queries/assignments.ts:112,135,231`,
`db/queries/fees.ts:540`, `db/queries/reportCards.ts:205`, `db/queries/messages.ts:80`; Test
`apps/api/src/__db_tests__/sessionScopedClasses.db.test.ts` (new).

- [ ] Steps: failing tests with a student promoted out of the class last session (absent from this session's
  attendance, homework, collection, report-card list and contacts); implement; pass; commit.

## Batch 9 — One table of who can do what (spec)

Spec amended by the decisions: **bursar payout is view-only** (`school.payout` splits into
`school.payout.view`: principal, bursar; `school.payout.manage`: principal); **principal holds `fees.manage`**.

### Task 9.1: The table, the guard, the tests
`apps/api/src/config/capabilities.json`, `apps/web/lib/capabilities.json` (identical; test), `middleware/requireCapability.ts`;
tests: route walker (every school route names a capability), identical copies, matrix test skeleton.

### Task 9.2–9.6: Routes move to the guard, one route file group per task
students/roster/sessions; scores/results/attendance/behaviour/notices; fees/payout/billing; users/schools/settings;
parent/student/messages/announcements/assignments/timetable. Each task grows the matrix test for its routes and
removes that file's `requireSchoolAccess` copy.

### Task 9.7: The sidebar, Settings rail and Roster tabs read the table
Settings rail filtered by capability (the bursar sees Payout Setup read-only and Platform Billing; no Fee
Settings); the principal gets Fees pages with working buttons and Promotions; the registrar gets Settings → Roster
with Classes and Subjects tabs. Command palette test updated per role.

### Task 9.8: Docs
`docs/roles-guide.md` rewritten from the table (bursar payout view-only), CLAUDE.md doctrine 1, CHANGELOG.

## Finish

- [ ] Full gate after each batch; whole-branch review by a fresh reviewer on the most capable model at the end.
- [ ] Show Moses each batch's diff; push only on his go; then CI, deploy, migrations, RLS drift and the read-only
  production checks; the King High School Test checklist walked with him.
