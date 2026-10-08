# One table of who can do what — design

Date: 8 Oct 2026. Status: approved (approach A); the later answers are in "Decided after review" below.
Plan: `docs/superpowers/plans/2026-10-08-roles-permissions.md`.

## Why

On 8 Oct 2026 a principal of King High School Test (a test school) made a "student" under Settings → Users,
and the registrar could not find it to give it a class. The causes (fixed separately, commits `a489e43`,
`dd9efaa`, not pushed) were one form making a login with no student record, and no screen able to give a
classless student a class. The reviewer's reading of the wider cause, confirmed in the code:

- Permission is decided in three unconnected places: the sidebar (`apps/web/lib/navigation.ts`), 25
  hand-written `requireSchoolAccess` copies (one per route file, not identical), and a `requireRole(...)`
  on each route. Nothing checks they agree.
- So a page can be shown that the API refuses, a route can exist that no role's screen reaches, and a role's
  job is whatever those three happened to say on the day each was written.

The open audit item "replace the per-file `requireSchoolAccess` copies with one guard"
(`docs/AUDIT-2026-09.md:278`) is the same problem, met as hardening.

## What Moses decided (8 Oct 2026)

- Approach A: one table, read by the sidebar, the command palette and the API, with tests that fail if they
  disagree.
- The rule for every row: **"Mostly you can only see what you have access to control or your role."** A role
  sees what it changes, and what its own job uses; nothing else.
- Answers to the six questions:
  1. School setup (calendar, grading, pass mark, assessment, identity, report card, notifications, export):
     **principal only**, as today.
  2. The registrar **manages classes and subjects** (Settings → Roster).
  3. The bursar **can look up students, read-only.**
  4. The principal **can record payments and refunds** as well as the bursar.
  5. A teacher sees **only the students in classes they teach or form-teach.**
  6. Teacher assignments (who teaches what): **principal only.**
- Earlier the same day: the principal can do the registrar's work (`docs/roles-guide.md`).
- Defaults stated and not objected to: a student no longer starts an online fee payment (parents pay; students
  have no fees page); parent and student access stay as they are (own children, own record).

## The table

A **capability** is one job. Each has an id and the roles that hold it. The super admin holds every school
capability, as today (platform support), and is not listed per row.

| Capability | What it covers | Roles |
|---|---|---|
| `school.setup` | School Identity (and logo, signature, stamp uploads), Academic Structure (sessions, terms, activation), grading (school-wide and by level), Assessment Config, Report Card Template, Notifications and its test email, Fee Settings, the school record itself | principal |
| `school.export` | Data Export (every dataset, the archive) | principal |
| `staff.manage` | Settings → Users: list, create, edit, activate, reset a password; staff bulk import | principal |
| `staff.email` | Changing a staff member's email address | none: the platform admin only |
| `roster.classes_subjects` | Create, edit, delete classes and subjects | principal, registrar |
| `roster.teaching` | Teacher assignments (single, bulk, copy from term, delete); roster bulk import | principal |
| `timetable.manage` | Create and delete timetable slots | principal |
| `students.manage` | Register (one or bulk), edit details and photo, Assign Class, Correct Class, promotions, add a parent, transcripts, a student's report card | principal, registrar |
| `students.view` | The student list and a student's profile, read-only | principal, registrar, bursar |
| `results.enter` | Score entry, class sheets, submitting results | principal, teacher (assigned classes, as today) |
| `results.manage` | Approval dashboard, approve, return, publish, class summary, generate report cards, report-card jobs and list, principal's remarks | principal |
| `class.daily` | Attendance (mark and read), behaviour records, class notices | principal, teacher (own classes, as today) |
| `class.comments` | Class teacher comments | as today: decided inside the route (the form teacher) |
| `school.overview` | Principal dashboard and analytics; behaviour summary | principal |
| `teacher.workspace` | Teacher dashboard, score-entry status, my students, assignments (set, mark) | teacher |
| `announcements.post` | Post a school-wide announcement | principal |
| `fees.manage` | Fee structures, invoices, outstanding balances, collection summary, record payments, payment bulk import, fee reminders, refunds, receipts | principal, bursar |
| `school.payout.view` | Payout Setup, read (the school's bank account for online fees) | principal, bursar |
| `school.payout.manage` | Payout Setup, saving a new account | principal |
| `school.billing` | Platform Billing (the school paying Chronix) | principal, bursar |
| `parent.portal` | A parent's children: results (published only), attendance, report cards, behaviour, fees, paying online, receipts | parent (linked children, as today) |
| `student.portal` | A student's own dashboard, results (published only), report card, notices, behaviour, assignments (submit) | student (self, as today) |
| `school.member` | What every signed-in member's own screens read: their own account (`/users/me`), messages, notifications, the current term, the list of sessions, classes and subjects, the timetable, announcements, the subscription banner | every role |

**Changes from today**, all from the decisions above:

- The registrar gains `roster.classes_subjects`, and sees Settings → Roster with the Classes and Subjects tabs
  only.
- The bursar gains `students.view`.
- The principal gains `fees.manage` (payments, refunds, payment import, reminders).
- A teacher loses the school-wide student list and profiles. Their own classes' students come through their
  class screens (class sheet, attendance, behaviour, my students), which no teacher screen stops using: no
  teacher page calls the student list or a student's profile today (checked 8 Oct 2026).
- A student loses starting an online payment.
- Two clean-ups: `POST /students/:studentId/promote` is removed (no screen calls it; Assign Class replaces
  it), and Fee Settings stops naming the bursar, whom its gatekeeper already refused.

**Row checks against the rule.** Every "view" above is a role's own job: the bursar finds a child to invoice
(decision 3); `school.member` is what each role's own screens already read to work at all. Anything outside
that is not given.

**Every route keeps exactly the roles it allows today, unless a change above says otherwise.** The plan
lists every school route with today's roles and the capability it moves to. A route whose roles fit no
capability exactly is raised with Moses before it moves, never fitted silently. Some routes serve two jobs:
a parent's dashboard and fees page read the same report-card and invoice routes as staff, so such a route
names every capability it serves, and any of them admits.

**Not in this table, unchanged:** which records inside a capability a person may touch. A teacher's assigned
classes, a parent's linked children, a student's own record, and the tenant check (your own school) stay in
the route logic that already enforces them. The table decides *whether a role does a job*; the route still
decides *which records*.

## Decided after review (8 Oct 2026)

The route inventory found 13 routes that fitted no row. Moses accepted the six recommendations, with the reviewer's
notes:

1. **The principal has everything the bursar has**, fee lines and invoice generation included. It is a rule on the
   table, tested, so a new fee route cannot default to bursar-only. The same holds for the registrar's jobs.
2. **A student does not read fee invoices.** Recorded as a removal with its reason, so it is not re-added as a gap.
3. **A staff member's email is changed by the platform admin only** (`staff.email`). The email is the account's only
   key and password resets go there; a principal who could change it could take the account.
4. **The open reads close:** a teacher's assignment list and pending scores (principal, and a teacher their own), the
   assessment structure (principal).
5. **The principal does not list every homework assignment.** Recorded as a removal with its reason.
6. **Fees appear in the principal's sidebar.**

Already decided: Payout Setup is viewed by the bursar and saved by the principal only ("Only view to avoid changes"),
hence `school.payout.view` and `school.payout.manage`. Open: whether a registrar may set a class's form teacher
(recommended: no; it is teaching work, principal only).

The reviewer's condition: the decisions land in the one table the API guard and the sidebar both read, with a test
that walks every mounted route and fails on a route outside the table, and a test that fails when a page is shown to a
role the routes it calls refuse. The plan's Tasks 1, 2 and 11.

## How it is enforced

**One file holds the table:** `apps/api/src/config/capabilities.json`, capability id → roles. The web keeps an
exact copy at `apps/web/lib/capabilities.json`; a test fails if the two differ (the pattern used for the
refund reasons and the staff roles). A script refreshes the copy.

**One guard on the API:** `requireCapability('students.manage')`, or several, any of which admits
(`requireCapability('fees.manage', 'parent.portal')`). It does the tenant check (your school, or a super
admin) and the role check, from the table. Every route under `/api/schools/:schoolId` uses it exactly
once, and the 25 `requireSchoolAccess` copies and the per-route `requireRole` lists on those routes go.
Routes outside a school (platform admin, partner, sign-in, Paystack's webhooks) keep their own guards; they
are not school jobs.

**The sidebar and the palette read it.** Each item in `navigation.ts`, the Settings sub-pages and the Roster
tabs included, names the capability it needs, and is shown only to roles that hold it. `settingsAccessForRole`
(`all | payout | none`) is replaced by the same rule. The command palette, which already builds from the
sidebar, follows.

**The tests that keep it true:**

1. **Every school route names a capability** (a walker over every router `index.ts` mounts, the one
   `twoFactorSetupRoutes.test.ts` already uses): fails on a route with no `requireCapability`, on one naming a
   capability not in the table, and on any remaining hand-written `requireSchoolAccess`.
2. **Every sidebar item names a capability in the table**, and per role the sidebar equals what the table
   gives that role (the command-palette test's "equals, not just non-empty" rule).
3. **The two copies of the table are identical.**
4. **A matrix test against the database:** for each capability, one route is called by every role. Holders
   are let in; everyone else gets 403. Both directions, because "refuses everyone" and "lets everyone in" each
   pass a one-sided test (doctrine 16).

**Docs:** `docs/roles-guide.md` is rewritten from the table. CLAUDE.md doctrine 1 changes from "requireSchoolAccess
is defined per route file and they are NOT identical" to the one guard and the table.

## Order of work

Each step is its own commit, tested, and shown to Moses; nothing is pushed without his go.

1. The table, the guard and its tests; no route uses it yet.
2. Routes move to the guard, file by file, the matrix test growing with them. The behaviour changes above land
   in the step that moves their route.
3. The sidebar, Settings and Roster tabs, and the palette read the table.
4. Docs; the three commits already waiting (Settings → Users staff-only, Assign Class, the countdown) go
   first, separately.

## Not in scope

- Which super admins may do what on the platform pages (their own guard, two-factor, root-only routes).
- Record-level rules beyond those named above.
- The database roles (C-4a): this is the API's permission layer, not the database's.
- Restricting a role's own-screen reads (`school.member`) further. If one is found to show a role something
  outside its job, it is raised with Moses as a row change.

## Risks

- **It touches nearly every school route.** Mitigation: move them in steps, each with the matrix test for the
  routes moved, and the route-walker test failing until every route is moved.
- **A page someone used could disappear from their sidebar.** That is the point when the role should not have
  it; where it is a mistake, the matrix test and a walk through each role's screens (a checklist for Moses after
  deploy) catch it.
- **A web copy of the table could drift.** The identical-copy test fails first.
