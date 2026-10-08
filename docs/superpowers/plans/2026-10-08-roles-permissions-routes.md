# Appendix: every school route, its roles today, and its capability

Appendix to `2026-10-08-roles-permissions.md`. Written as a read-only inventory on 8 Oct 2026, then updated the same day:
the 13 routes that fitted no capability carry the decision that places them (the plan's "Decisions this plan carries"),
and Payout Setup is split into `school.payout.view` and `school.payout.manage`. Section 4's items 1-5 and 10 were fixed
in `a4505a1` (Batch 8); items 6-9 are Task 10.

Read-only inventory, 8 Oct 2026, of the 25 routers `apps/api/src/index.ts:150-174` mounts under `/api/schools`, behind `detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription` (index.ts:137-148). Spec: `docs/superpowers/specs/2026-10-08-roles-permissions-design.md`.

How to read the table

- **roles admitted today** is the intersection of the file's `requireSchoolAccess` (the per-file definition, quoted in "Guards per file" below), any `requireRole(...)`, and inline handler checks. `super_admin` is listed wherever it is really admitted; where it is not (e.g. `requireRole('bursar')`) it is absent on purpose.
- A support-session token carries the impersonated user's role (CLAUDE.md, Auth), so `super_admin` only reaches these routes directly; the column is still kept exact.
- **fits?** `yes` = the capability's roles (plus super_admin) equal today's roles. `yes (after change: ...)` = equal once one of the spec's "Changes from today" is applied. `yes (roles equal; job not named in spec ...)` = roles equal but the spec's description of that capability does not name this job, so confirm the placement. `NO - reason` = does not fit; listed in "Routes that do not fit". `n/a` = not a school job, or removed by the spec.
- The first two columns give the route as `METHOD path` (path is relative to `/api/schools`); `file:line` is the `router.<method>(` line.

## Guards per file (the `requireSchoolAccess` copies)

| File | `requireSchoolAccess` admits | Other guards defined |
|---|---|---|
| schools.ts:155 | super_admin, or principal of this school ONLY | `requirePayoutAccess` (:168): super_admin, principal or bursar of this school; inline guard on `GET /subscription-status` (:387): super_admin or any member |
| users.ts:90 | super_admin, or principal of this school ONLY | `requireSchoolMember` (:106): super_admin or any member |
| assignments.ts:42 | any member of this school; super_admin is NOT admitted (no school_id match) | - |
| student.ts:23 | any member of this school; super_admin is NOT admitted | `requireStudentRecord` (:34): caller must have a students row |
| parent.ts:17 | super_admin or any member | `requireLinkedChild` (:28): parent linked to :studentId (super_admin bypasses) |
| fees.ts:60 | super_admin or any member | `requireFeeInvoiceAccess` (:90): bursar/principal/super_admin any; parent linked; student own |
| sessions, roster, assessmentConfig, students, scores, results, dashboard, teacherDashboard, attendance, behaviour, messages, announcements, notifications, platformBilling, analytics, timetable, classComments, principalRemarks, notices | super_admin or any member of this school (identical copies) | dashboard/teacherDashboard/analytics bundle it into `const guard` with `requireRole`; analytics adds `requireFeature('analytics')` |

`requireRole` (middleware/auth.ts:255) admits only the roles listed: it does NOT let super_admin through by default.

## 1. The table

| method | path | file:line | roles admitted today | inline / record checks | proposed capability | fits? |
|---|---|---|---|---|---|---|
| POST | / | schools.ts:239 | super_admin | requireRole(super_admin) only; NOT under /:schoolId (creates a school: platform job) | n/a (platform; keeps its own guard) | n/a - not a school job |
| GET | /:schoolId/export | schools.ts:283 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.export | yes |
| GET | /:schoolId/export/archive | schools.ts:301 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school; audits SCHOOL_DATA_EXPORTED | school.export | yes |
| GET | /:schoolId/export/:dataset | schools.ts:350 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.export | yes |
| GET | /:schoolId/subscription-status | schools.ts:385 | every member of the school + super_admin | inline guard in the route (:387-391): super_admin or same school; deliberately wider than the file guard | school.member | yes |
| GET | /:schoolId/setup-status | schools.ts:422 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes (roles equal; job not named in spec: principal setup checklist) |
| GET | /:schoolId | schools.ts:436 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school. The school record (logo, name, report config) is principal-only | school.setup | yes |
| PATCH | /:schoolId/identity | schools.ts:461 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| GET | /:schoolId/academic-config/levels | schools.ts:533 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| PATCH | /:schoolId/academic-config | schools.ts:582 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| GET | /:schoolId/fee-config | schools.ts:692 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school (Fee Settings read) | school.setup | yes |
| PATCH | /:schoolId/fee-config | schools.ts:723 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school AND requireRole(principal, bursar, super_admin) (:727): the file guard refuses the bursar first, so effective = super_admin, principal. The bursar is named but never admitted | school.setup | yes (after change: spec clean-up: Fee Settings stops naming the bursar) |
| PATCH | /:schoolId/notification-config | schools.ts:755 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| PATCH | /:schoolId/report-config | schools.ts:815 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| POST | /:schoolId/report-config/preview | schools.ts:853 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| POST | /:schoolId/notifications/test-email | schools.ts:882 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school; emails the caller | school.setup | yes |
| POST | /:schoolId/logo | schools.ts:919 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| POST | /:schoolId/signature | schools.ts:979 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school (the SCHOOL signature, not a staff one) | school.setup | yes |
| POST | /:schoolId/stamp | schools.ts:1039 | super_admin, principal | schools.ts requireSchoolAccess (:155) = super_admin or principal of this school | school.setup | yes |
| GET | /:schoolId/settings/payout | schools.ts:1099 | super_admin, principal, bursar | requirePayoutAccess (:168) + requireFeature(online_payments) | school.payout.view | yes |
| GET | /:schoolId/settings/payout/banks | schools.ts:1128 | super_admin, principal, bursar | requirePayoutAccess + requireFeature(online_payments) | school.payout.view | yes |
| POST | /:schoolId/settings/payout/resolve | schools.ts:1151 | super_admin, principal, bursar | requirePayoutAccess + requireFeature(online_payments) | school.payout.view | yes |
| PUT | /:schoolId/settings/payout | schools.ts:1194 | super_admin, principal | uses requireSchoolAccess, NOT requirePayoutAccess (:1197); comment :1181-1185 says bursar deliberately excluded ("keeps read and resolve"); requireFeature(online_payments); password step-up inside | school.payout.manage | decided: the bursar views, the principal saves ("Only view to avoid changes") |
| POST | /:schoolId/sessions | sessions.ts:89 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| GET | /:schoolId/sessions | sessions.ts:111 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole | school.member | yes |
| POST | /:schoolId/sessions/:sessionId/terms | sessions.ts:127 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| PATCH | /:schoolId/sessions/:sessionId/terms/:termId | sessions.ts:212 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| PATCH | /:schoolId/sessions/:sessionId/activate | sessions.ts:269 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| PATCH | /:schoolId/sessions/:sessionId/terms/:termId/activate | sessions.ts:316 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| GET | /:schoolId/current-context | sessions.ts:376 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole | school.member | yes |
| POST | /:schoolId/classes | roster.ts:124 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.classes_subjects | yes (after change: registrar gains) |
| GET | /:schoolId/classes | roster.ts:177 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole | school.member | yes |
| PATCH | /:schoolId/classes/:classId | roster.ts:195 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.classes_subjects | yes (after change: registrar gains) |
| DELETE | /:schoolId/classes/:classId | roster.ts:261 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.classes_subjects | yes (after change: registrar gains) |
| POST | /:schoolId/subjects | roster.ts:306 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.classes_subjects | yes (after change: registrar gains) |
| GET | /:schoolId/subjects | roster.ts:350 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole | school.member | yes |
| PATCH | /:schoolId/subjects/:subjectId | roster.ts:368 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.classes_subjects | yes (after change: registrar gains) |
| DELETE | /:schoolId/subjects/:subjectId | roster.ts:418 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.classes_subjects | yes (after change: registrar gains) |
| POST | /:schoolId/teacher-assignments | roster.ts:463 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.teaching | yes |
| GET | /:schoolId/teachers/:teacherId/assignments | roster.ts:521 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole, NO self check: any member can read any teacher's assignments (cached 60s). Only Settings pages (principal) call it | roster.teaching \| teacher.workspace (own, in the handler) | decided (4): principal, and a teacher their own |
| POST | /:schoolId/teacher-assignments/bulk | roster.ts:546 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.teaching | yes |
| POST | /:schoolId/teacher-assignments/copy-from-term | roster.ts:625 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.teaching | yes |
| DELETE | /:schoolId/teacher-assignments/:id | roster.ts:680 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.teaching | yes |
| POST | /:schoolId/roster-bulk-import/preview | roster.ts:730 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.teaching | yes |
| POST | /:schoolId/roster-bulk-import/commit | roster.ts:854 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | roster.teaching | yes |
| GET | /:schoolId/users/me | users.ts:129 | every member of the school + super_admin | requireSchoolMember (:106); returns only the caller's own row | school.member | yes |
| GET | /:schoolId/users | users.ts:155 | super_admin, principal | users.ts requireSchoolAccess (:90) = super_admin or principal of this school + requireRole(super_admin, principal); also read by the Roster and Timetable pages for the teacher picker | staff.manage | yes |
| POST | /:schoolId/users | users.ts:178 | super_admin, principal | users.ts requireSchoolAccess (:90) = super_admin or principal of this school + requireRole(super_admin, principal); staff roles only (STAFF_ROLES) | staff.manage | yes |
| PATCH | /:schoolId/users/:userId | users.ts:268 | super_admin, principal | users.ts requireSchoolAccess (:90) = super_admin or principal of this school + requireRole(super_admin, principal) | staff.manage | yes |
| PATCH | /:schoolId/users/:userId/status | users.ts:306 | super_admin, principal | users.ts requireSchoolAccess (:90) = super_admin or principal of this school + requireRole(super_admin, principal) | staff.manage | yes |
| PATCH | /:schoolId/users/:userId/email | users.ts:383 | super_admin | file guard admits super_admin + principal, then requireRole(super_admin) (:387) narrows to super_admin only | staff.email | decided (3): platform admin only; the email is the account's only key |
| POST | /:schoolId/users/:userId/reset-password | users.ts:454 | super_admin, principal | users.ts requireSchoolAccess (:90) = super_admin or principal of this school + requireRole(super_admin, principal) | staff.manage | yes |
| POST | /:schoolId/users/:userId/signature | users.ts:554 | every member of the school + super_admin | requireSchoolMember; inline (:564-568): isSelf OR role in (super_admin, principal), else 403. A teacher uploads their own signature (class-comments page) | school.member (self) \| staff.manage (others) | yes (roles equal; job not named in spec: own-signature upload is not named in school.member; self-or-admin stays in the handler) |
| POST | /:schoolId/staff-bulk-import/preview | users.ts:629 | super_admin, principal | users.ts requireSchoolAccess (:90) = super_admin or principal of this school + requireRole(super_admin, principal) | staff.manage | yes |
| POST | /:schoolId/staff-bulk-import/commit | users.ts:737 | super_admin, principal | users.ts requireSchoolAccess (:90) = super_admin or principal of this school + requireRole(super_admin, principal) | staff.manage | yes |
| POST | /:schoolId/assessment-config | assessmentConfig.ts:80 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| POST | /:schoolId/assessment-config/copy-from-term | assessmentConfig.ts:147 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| GET | /:schoolId/assessment-config | assessmentConfig.ts:216 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, NO requireRole. Only Settings -> Assessment Config (principal) calls it | school.setup | decided (4): principal only |
| GET | /:schoolId/assessment-config/resolve | assessmentConfig.ts:232 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, NO requireRole. Only Settings -> Assessment Config (principal) calls it | school.setup | decided (4): principal only |
| PATCH | /:schoolId/assessment-config/:configId | assessmentConfig.ts:265 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| DELETE | /:schoolId/assessment-config/:configId | assessmentConfig.ts:331 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.setup | yes |
| POST | /:schoolId/students | students.ts:164 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| POST | /:schoolId/students/bulk-import/preview | students.ts:279 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| POST | /:schoolId/students/bulk-import/commit | students.ts:413 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| GET | /:schoolId/students | students.ts:577 | super_admin, principal, registrar, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar, teacher). NO class scoping for the teacher: school-wide list | students.view | yes (after change: teacher loses, bursar gains) |
| GET | /:schoolId/students/:studentId | students.ts:613 | super_admin, principal, registrar, teacher, parent, student | file requireSchoolAccess = super_admin or any member of this school + requireRole(... teacher, parent, student); inline: parent must be linked (checkParentStudentLink), student must be own record; teacher: any student, no class check | students.view \| parent.portal \| student.portal | yes (after change: teacher loses, bursar gains) |
| PATCH | /:schoolId/students/:studentId | students.ts:656 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| POST | /:schoolId/students/:studentId/photo | students.ts:697 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| POST | /:schoolId/students/:studentId/promote | students.ts:762 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal); no web page calls it | (none: removed by spec) | n/a - spec removes this route |
| GET | /:schoolId/students/:studentId/report-card | students.ts:826 | super_admin, principal, registrar, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar, parent); inline: parent must be linked and sees only is_published report cards; staff see unpublished | students.manage \| parent.portal | yes |
| POST | /:schoolId/students/:studentId/class | students.ts:892 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar); Assign Class, audited STUDENT_CLASS_ASSIGNED | students.manage | yes |
| PATCH | /:schoolId/students/:studentId/class | students.ts:940 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar); Correct Class (needs a reason) | students.manage | yes |
| POST | /:schoolId/students/promote-bulk | students.ts:999 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| POST | /:schoolId/students/:studentId/parents | students.ts:1071 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| POST | /:schoolId/students/:studentId/transcript | students.ts:1204 | super_admin, principal, registrar | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, registrar) | students.manage | yes |
| POST | /:schoolId/scores/entry | scores.ts:69 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: teacher must be assigned (checkTeacherAssigned), principal/super_admin bypass; student must be in the class (findStudentsNotInClass). No web page calls it | results.enter | yes |
| GET | /:schoolId/scores/class-sheet | scores.ts:172 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: teacher must be assigned (:190-198) | results.enter | yes |
| POST | /:schoolId/scores/bulk-entry | scores.ts:217 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: teacher must be assigned (:233); targets validated | results.enter | yes |
| GET | /:schoolId/scores/my-pending | scores.ts:308 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, NO requireRole; inline (:318-326): teacher_id other than own only for super_admin/principal. A student/parent/registrar/bursar gets an empty list. No web page calls it | results.enter (a teacher their own, in the handler) | decided (4): principal, and a teacher their own |
| POST | /:schoolId/results/submit | results.ts:97 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: teacher must hold a teacher_assignments row (:115-128) | results.enter | yes |
| GET | /:schoolId/results/approval-dashboard | results.ts:205 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| GET | /:schoolId/results/class-summary | results.ts:248 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| POST | /:schoolId/results/approve | results.ts:290 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| POST | /:schoolId/results/publish | results.ts:390 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| POST | /:schoolId/results/return | results.ts:521 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| POST | /:schoolId/results/generate-report-cards | results.ts:683 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| GET | /:schoolId/results/report-card-jobs/:jobId | results.ts:744 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| GET | /:schoolId/results/report-cards | results.ts:773 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| GET | /:schoolId/dashboard/principal/overview | dashboard.ts:37 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) (const guard :33) | school.overview | yes |
| GET | /:schoolId/dashboard/principal/result-status | dashboard.ts:94 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) (const guard :33). No web page calls it | school.overview | yes |
| GET | /:schoolId/dashboard/principal/students-at-risk | dashboard.ts:116 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) (const guard :33) | school.overview | yes |
| GET | /:schoolId/dashboard/principal/teacher-activity | dashboard.ts:138 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) (const guard :33) | school.overview | yes |
| GET | /:schoolId/dashboard/principal/class-selector | dashboard.ts:160 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) (const guard :33). No web page calls it | school.overview | yes |
| GET | /:schoolId/dashboard/teacher/overview | teacherDashboard.ts:46 | super_admin, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(teacher, super_admin) (const guard :26) | teacher.workspace | yes |
| GET | /:schoolId/dashboard/teacher/score-entry-status | teacherDashboard.ts:67 | super_admin, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(teacher, super_admin) (const guard :26) | teacher.workspace | yes |
| GET | /:schoolId/dashboard/teacher/my-students | teacherDashboard.ts:90 | super_admin, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(teacher, super_admin) (const guard :26). No web page calls it; takes class_id, teacher must be assigned | teacher.workspace | yes |
| GET | /:schoolId/dashboard/teacher/notifications | teacherDashboard.ts:135 | super_admin, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(teacher, super_admin) (const guard :26) | teacher.workspace | yes |
| POST | /:schoolId/attendance/mark | attendance.ts:108 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: teacher must be the form teacher OR assigned to the class this term (:138-141) | class.daily | yes |
| GET | /:schoolId/attendance/class | attendance.ts:239 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline canTeacherViewClass (form teacher or assigned any term) | class.daily | yes |
| GET | /:schoolId/attendance/student/:studentId | attendance.ts:274 | super_admin, principal, teacher, parent, student | file requireSchoolAccess = super_admin or any member of this school, NO requireRole; inline (:298-315): super_admin/principal/teacher any student (no class check), parent must be linked, student must be own, any other role (registrar, bursar) gets 403 | class.daily \| parent.portal \| student.portal | yes |
| GET | /:schoolId/attendance/monthly-summary | attendance.ts:324 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline canTeacherViewClass | class.daily | yes |
| GET | /:schoolId/attendance/class-summary | attendance.ts:359 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); school-wide % per class, NO class check for a teacher | class.daily | yes |
| GET | /:schoolId/attendance/alerts | attendance.ts:387 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); all unresolved alerts, NO class check for a teacher | class.daily | yes |
| PATCH | /:schoolId/attendance/alerts/:alertId/resolve | attendance.ts:406 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | school.overview | yes (roles equal; job not named in spec: resolving an attendance alert is not named in school.overview; class.daily would add the teacher) |
| GET | /:schoolId/parent/children | parent.ts:87 | super_admin, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, super_admin) | parent.portal | yes |
| GET | /:schoolId/parent/students/:studentId/snapshot | parent.ts:104 | super_admin, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, super_admin) + requireLinkedChild (parent must be linked; super_admin bypasses) | parent.portal | yes |
| GET | /:schoolId/parent/students/:studentId/results | parent.ts:182 | super_admin, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, super_admin) + requireLinkedChild (parent must be linked; super_admin bypasses) | parent.portal | yes |
| GET | /:schoolId/parent/students/:studentId/report-card | parent.ts:271 | super_admin, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, super_admin) + requireLinkedChild (parent must be linked; super_admin bypasses). No web page calls it | parent.portal | yes |
| GET | /:schoolId/parent/students/:studentId/attendance | parent.ts:309 | super_admin, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, super_admin) + requireLinkedChild (parent must be linked; super_admin bypasses) | parent.portal | yes |
| GET | /:schoolId/parent/students/:studentId/notices | parent.ts:340 | super_admin, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, super_admin) + requireLinkedChild (parent must be linked; super_admin bypasses) | parent.portal | yes |
| GET | /:schoolId/student/dashboard | student.ts:92 | student | student.ts requireSchoolAccess (:23) = same school only (super_admin NOT admitted) + requireRole(student) + requireStudentRecord (own record) | student.portal | yes |
| GET | /:schoolId/student/results | student.ts:189 | student | student.ts requireSchoolAccess (:23) = same school only (super_admin NOT admitted) + requireRole(student) + requireStudentRecord (own record) (published only) | student.portal | yes |
| GET | /:schoolId/student/report-card | student.ts:279 | student | student.ts requireSchoolAccess (:23) = same school only (super_admin NOT admitted) + requireRole(student) + requireStudentRecord (own record). No web page calls it | student.portal | yes |
| GET | /:schoolId/student/notices | student.ts:318 | student | student.ts requireSchoolAccess (:23) = same school only (super_admin NOT admitted) + requireRole(student) + requireStudentRecord (own record) | student.portal | yes |
| POST | /:schoolId/assignments | assignments.ts:87 | teacher | assignments.ts requireSchoolAccess (:42) = same school only (super_admin NOT admitted) + requireRole(teacher) | teacher.workspace | yes |
| GET | /:schoolId/assignments | assignments.ts:164 | teacher, student, principal (super_admin listed in requireRole but refused by the file guard) | assignments.ts requireSchoolAccess (:42) = same school only (super_admin NOT admitted) + requireRole(teacher, student, super_admin, principal); handler returns teacher's own, school-wide for principal/super_admin, class's for student. No principal page calls it | teacher.workspace \| student.portal | decided (5): the principal is refused; recorded in REMOVED_ROUTES |
| GET | /:schoolId/assignments/:assignmentId/submissions | assignments.ts:214 | teacher | assignments.ts requireSchoolAccess (:42) = same school only (super_admin NOT admitted) + requireRole(teacher); inline: assignment.teacher_id must equal the caller | teacher.workspace | yes |
| POST | /:schoolId/assignments/:assignmentId/submissions | assignments.ts:249 | student | assignments.ts requireSchoolAccess (:42) = same school only (super_admin NOT admitted) + requireRole(student); inline: assignment must be for the student's class, before due date | student.portal | yes |
| PATCH | /:schoolId/assignments/:assignmentId/submissions/:studentId | assignments.ts:313 | teacher | assignments.ts requireSchoolAccess (:42) = same school only (super_admin NOT admitted) + requireRole(teacher) (marking) | teacher.workspace | yes |
| POST | /:schoolId/behaviour | behaviour.ts:56 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(teacher, principal, super_admin); inline: non-admin must be form teacher or assigned to the class this term (:98-103) | class.daily | yes |
| GET | /:schoolId/behaviour/students/:studentId | behaviour.ts:153 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(teacher, principal, super_admin); NO class check for a teacher: any student's history | class.daily | yes |
| GET | /:schoolId/behaviour/students/:studentId/summary | behaviour.ts:178 | super_admin, parent, student | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, student, super_admin) (principal NOT admitted); inline: parent linked, student own | parent.portal \| student.portal | yes |
| GET | /:schoolId/behaviour/summary | behaviour.ts:217 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(principal, super_admin) | school.overview | yes |
| GET | /:schoolId/messages/contacts | messages.ts:71 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school; contacts computed by caller's role | school.member | yes |
| POST | /:schoolId/messages | messages.ts:89 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school + messageLimiter; recipients limited by role in getMessageContacts | school.member | yes |
| GET | /:schoolId/messages/inbox | messages.ts:176 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school | school.member | yes |
| GET | /:schoolId/messages/thread/:threadId | messages.ts:194 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school; thread membership checked in the query layer (not re-verified here) | school.member | yes |
| POST | /:schoolId/announcements | announcements.ts:64 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + announcementLimiter + requireRole(principal, super_admin) | announcements.post | yes |
| GET | /:schoolId/announcements | announcements.ts:140 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school; listAnnouncementsForRole filters by the caller's role | school.member | yes |
| GET | /:schoolId/notifications | notifications.ts:22 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school; caller's own notifications | school.member | yes |
| PATCH | /:schoolId/notifications/:id/read | notifications.ts:39 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school | school.member | yes |
| PATCH | /:schoolId/notifications/read-all | notifications.ts:55 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school | school.member | yes |
| POST | /:schoolId/fee-structures | fees.ts:204 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | decided (1): the principal has everything the bursar has |
| PATCH | /:schoolId/fee-structures/:id | fees.ts:261 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | decided (1) |
| DELETE | /:schoolId/fee-structures/:id | fees.ts:310 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | decided (1) |
| POST | /:schoolId/fee-structures/copy-from-term | fees.ts:343 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | decided (1) |
| GET | /:schoolId/fee-structures | fees.ts:380 | super_admin, principal, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, principal, super_admin) | fees.manage | yes |
| GET | /:schoolId/fee-invoices | fees.ts:406 | super_admin, principal, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, principal, super_admin) | fees.manage | yes |
| POST | /:schoolId/fee-invoices/generate | fees.ts:432 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | decided (1) |
| GET | /:schoolId/fee-invoices/outstanding | fees.ts:478 | super_admin, principal, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, principal, super_admin) | fees.manage | yes |
| GET | /:schoolId/fee-invoices/summary | fees.ts:504 | super_admin, principal, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, principal, super_admin) | fees.manage | yes |
| GET | /:schoolId/fee-invoices/student/:studentId | fees.ts:530 | super_admin, principal, bursar, parent, student | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, principal, super_admin, parent, student) + requireFeeInvoiceAccess (:90): staff any, parent linked, student own record. No student page calls it | fees.manage \| parent.portal | decided (2): the student is refused; recorded in REMOVED_ROUTES |
| POST | /:schoolId/payments | fees.ts:571 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | yes (after change: principal gains payments) |
| GET | /:schoolId/payments/:paymentId/receipt | fees.ts:699 | super_admin, principal, bursar, parent | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, principal, super_admin, parent); inline (:713): parent must be linked to the payment's student | fees.manage \| parent.portal | yes |
| POST | /:schoolId/payments/:paymentId/refunds | fees.ts:786 | bursar (super_admin NOT admitted: requireRole(bursar) only) | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar) | fees.manage | yes (after change: principal gains refunds; super_admin gains it too, which the table gives every school capability) |
| POST | /:schoolId/payments/paystack/initiate | fees.ts:847 | parent, student | file requireSchoolAccess = super_admin or any member of this school + requireRole(parent, student) + requireFeature(online_payments); inline (:868): parent linked / student own invoice (canAccessInvoiceForStudent) | parent.portal | yes (after change: student loses starting an online payment) |
| POST | /:schoolId/fee-reminders/run | fees.ts:976 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | yes (after change: principal gains reminders) |
| POST | /:schoolId/payments-bulk-import/preview | fees.ts:1062 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | yes (after change: principal gains payment import) |
| POST | /:schoolId/payments-bulk-import/commit | fees.ts:1169 | super_admin, bursar | file requireSchoolAccess = super_admin or any member of this school + requireRole(bursar, super_admin) | fees.manage | yes (after change: principal gains payment import) |
| GET | /:schoolId/platform-billing/status | platformBilling.ts:60 | super_admin, principal, bursar | no verifyToken in route (the mount chain has it) + file guard (any member) + requireRole(principal, bursar, super_admin) | school.billing | yes |
| POST | /:schoolId/platform-billing/checkout | platformBilling.ts:103 | super_admin, principal, bursar | same as status; carved out of the read-only gate (READ_ONLY_WRITE_ALLOWLIST) | school.billing | yes |
| GET | /:schoolId/analytics/overview | analytics.ts:48 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(principal, super_admin) + requireFeature(analytics) (plan gate, all plans have it) | school.overview | yes |
| POST | /:schoolId/timetable | timetable.ts:71 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | timetable.manage | yes |
| GET | /:schoolId/timetable/class/:classId | timetable.ts:141 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole; inline (:157): a student may read only their own class(es); every other role any class | school.member | yes |
| GET | /:schoolId/timetable/teacher/:teacherId | timetable.ts:179 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole; inline (:187): a teacher may read only their own; every other role (incl. parent, student) any teacher | school.member | yes |
| DELETE | /:schoolId/timetable/:slotId | timetable.ts:211 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | timetable.manage | yes |
| GET | /:schoolId/class-comments | classComments.ts:33 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole; handler answers 404 NOT_FORM_TEACHER unless the caller is a class's form_teacher_id | class.comments | yes |
| PUT | /:schoolId/class-comments/:studentId | classComments.ts:72 | every member of the school + super_admin | file requireSchoolAccess = super_admin or any member of this school, no requireRole; inline (:94-96): caller must be the form teacher of the student's class, or super_admin/principal | class.comments | yes |
| GET | /:schoolId/principal-remarks/:studentId | principalRemarks.ts:46 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| PUT | /:schoolId/principal-remarks/:studentId | principalRemarks.ts:79 | super_admin, principal | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal) | results.manage | yes |
| GET | /:schoolId/notices | notices.ts:147 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: a teacher only posts/deletes for a class they form-teach or are assigned to this term; GET lists only those classes for a teacher | class.daily | yes |
| POST | /:schoolId/notices | notices.ts:185 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: a teacher only posts/deletes for a class they form-teach or are assigned to this term; GET lists only those classes for a teacher | class.daily | yes |
| DELETE | /:schoolId/notices/:noticeId | notices.ts:242 | super_admin, principal, teacher | file requireSchoolAccess = super_admin or any member of this school + requireRole(super_admin, principal, teacher); inline: a teacher only posts/deletes for a class they form-teach or are assigned to this term; GET lists only those classes for a teacher | class.daily | yes |

### Mounted under `/api/schools` but excluded (not `/:schoolId` school jobs, no auth chain)

- `feesPublic.ts:49` GET `/:schoolId/payments/paystack/callback` and `feesPublic.ts:110` POST `/:schoolId/payments/paystack/webhook`: Paystack browser redirect and server webhook, mounted before the auth chain (index.ts:130), no bearer. Settled only through the stored `fee_checkouts` record.
- `platformBillingPublic.ts:29` GET `/platform-billing/callback` and `platformBillingPublic.ts:66` POST `/platform-billing/webhook`: same, for the school paying Chronix (index.ts:134).
- `schools.ts:239` POST `/` (create a school) is in the table above for completeness; it is `super_admin` only and not a school job.

## 2. Routes that do not fit

13 rows are NO. Grouped by the decision each needs.

### 2.1 Payout write (1 route)

- `PUT /:schoolId/settings/payout` (schools.ts:1194). Today: super_admin, principal (file guard; the bursar is deliberately kept to read and resolve, comment schools.ts:1181-1185, plus a password step-up). Closest capability `school.payout` = principal, bursar. **Question:** the table gives `school.payout` to the bursar for all four payout routes. Do you want the bursar to be able to SAVE a new settlement bank account (this lets the bursar redirect the school's fee money), or does the write stay principal-only? If it stays principal-only it needs its own capability (or to sit under `school.setup`) while GET, banks and resolve stay `school.payout`. The web page already splits it: `canEdit = isAdminRole(role)` (settings/payout/page.tsx:51).

### 2.2 Fee-structure and invoice-generation writes (5 routes)

- `POST /:schoolId/fee-structures` (fees.ts:204). Today: super_admin, bursar.
- `PATCH /:schoolId/fee-structures/:id` (fees.ts:261). Today: super_admin, bursar.
- `DELETE /:schoolId/fee-structures/:id` (fees.ts:310). Today: super_admin, bursar.
- `POST /:schoolId/fee-structures/copy-from-term` (fees.ts:343). Today: super_admin, bursar.
- `POST /:schoolId/fee-invoices/generate` (fees.ts:432). Today: super_admin, bursar.
- Closest capability `fees.manage` = principal, bursar. The principal can READ these today (fee-structures, fee-invoices lists) but not write. **Question:** the spec says "The principal gains `fees.manage` (payments, refunds, payment import, reminders)". Does the principal also gain creating, editing, deleting and copying fee lines, and generating invoices? If yes, these 5 are an additional change to record. If no, they need a bursar-only capability. Note `fees.manage` as written in the table also lists "fee structures, invoices".

### 2.3 A student reading their own invoice (1 route)

- `GET /:schoolId/fee-invoices/student/:studentId` (fees.ts:530). Today: super_admin, principal, bursar, parent (linked child), student (own record). Closest: `fees.manage | parent.portal` = principal, bursar, parent. `student.portal` does not list fees and the spec says "students have no fees page". No student page calls this route (only parent/dashboard, parent/fees and bursar/invoices do). **Question:** drop the student from this route (the spec's stated default), or add fees to `student.portal`?

### 2.4 Changing a staff member's email (1 route)

- `PATCH /:schoolId/users/:userId/email` (users.ts:383). Today: super_admin only (explicit `requireRole('super_admin')` at :387 after the principal-admitting file guard). Closest: `staff.manage` = principal. **Question:** keep it super_admin-only (platform support) as a named exception outside `staff.manage`, or give the principal this action? The spec lists "edit" under `staff.manage` without saying email.

### 2.5 Reads that every role may make today (4 routes)

- `GET /:schoolId/teachers/:teacherId/assignments` (roster.ts:521). Today: every member, any teacher's assignments, no self check. Called only by Settings -> Roster and Settings -> Users (principal). Closest: `roster.teaching` = principal. **Question:** restrict to principal (and a teacher reading their own?), or leave open?
- `GET /:schoolId/assessment-config` (assessmentConfig.ts:216). Today: every member. Called only by Settings -> Assessment Config (principal). Closest: `school.setup` = principal, or `results.enter` = principal + teacher. **Question:** principal only, or principal + teacher? (No teacher page calls it today.)
- `GET /:schoolId/assessment-config/resolve` (assessmentConfig.ts:232). Same as the line above; also only called by the principal's Assessment Config page.
- `GET /:schoolId/scores/my-pending` (scores.ts:308). Today: every member (inline: another teacher's id only for super_admin/principal; other roles get an empty list). No web page calls it. Closest: `results.enter` = principal + teacher, or `teacher.workspace` = teacher. **Question:** restrict to teachers (and principal), or delete the unused route?

### 2.6 The principal listing every assignment (1 route)

- `GET /:schoolId/assignments` (assignments.ts:164). Today: teacher (own), student (own class), principal (every assignment in the school). `requireRole` also lists super_admin but the file's `requireSchoolAccess` (:42) refuses it, so that entry is dead. Closest: `teacher.workspace | student.portal` = teacher, student; the principal fits neither, and no principal page calls it. **Question:** drop the principal, or name a capability for the principal's read (e.g. add it to `school.overview`)?

### Roles equal, job not named in the spec (confirm placement; not counted as NO)

- `GET /:schoolId/setup-status` (schools.ts:422): school.setup. job not named in spec: principal setup checklist.
- `POST /:schoolId/users/:userId/signature` (users.ts:554): school.member (self) | staff.manage (others). job not named in spec: own-signature upload is not named in school.member; self-or-admin stays in the handler.
- `PATCH /:schoolId/attendance/alerts/:alertId/resolve` (attendance.ts:406): school.overview. job not named in spec: resolving an attendance alert is not named in school.overview; class.daily would add the teacher.

### Where the table would change what `super_admin` can do (all currently refuse it)

The spec says the super admin holds every school capability. Today these routes refuse it, so moving them to `requireCapability` widens super_admin:
- `POST /:schoolId/payments/:paymentId/refunds` (fees.ts:786): `requireRole('bursar')` only.
- `POST /:schoolId/payments/paystack/initiate` (fees.ts:847): `requireRole('parent', 'student')`.
- `assignments.ts` POST /assignments, GET and PATCH submissions (`requireRole('teacher')`), POST submissions (`requireRole('student')`); and the whole file guard (assignments.ts:42) rejects super_admin.
- all four `student.ts` routes (file guard :23 and `requireRole('student')`).
- `GET /:schoolId/behaviour/students/:studentId/summary` and the `parent.ts` routes admit super_admin but the principal is not admitted to the behaviour summary (behaviour.ts:178).
- Not wider: `GET /attendance/student/:studentId` (attendance.ts:274) answers 403 inline to registrar and bursar although its guard has no `requireRole`.

### Record-level gaps worth knowing while moving routes (not role mismatches)

- Teacher reads with no class check, so decision 5 ("a teacher sees only the students in classes they teach or form-teach") is not true of these today: `GET /students` and `GET /students/:studentId` (students.ts:577, 613; the spec drops the teacher from both), `GET /attendance/student/:studentId` (attendance.ts:298), `GET /attendance/class-summary` and `/attendance/alerts` (attendance.ts:359, 387), `GET /behaviour/students/:studentId` (behaviour.ts:153). The spec does not say whether these should gain a class check when they move to `class.daily`.
- `GET /timetable/teacher/:teacherId` lets parents and students read any teacher's timetable (timetable.ts:179, only a teacher is restricted to self); `GET /timetable/class/:classId` lets parents read any class.

## 3. Counts

| file | routes | NO |
|---|---|---|
| schools.ts | 23 | 1 |
| sessions.ts | 7 | 0 |
| roster.ts | 15 | 1 |
| users.ts | 10 | 1 |
| assessmentConfig.ts | 6 | 2 |
| students.ts | 14 | 0 |
| scores.ts | 4 | 1 |
| results.ts | 9 | 0 |
| dashboard.ts | 5 | 0 |
| teacherDashboard.ts | 4 | 0 |
| attendance.ts | 7 | 0 |
| parent.ts | 6 | 0 |
| student.ts | 4 | 0 |
| assignments.ts | 5 | 1 |
| behaviour.ts | 4 | 0 |
| messages.ts | 4 | 0 |
| announcements.ts | 2 | 0 |
| notifications.ts | 3 | 0 |
| fees.ts | 17 | 6 |
| platformBilling.ts | 2 | 0 |
| analytics.ts | 1 | 0 |
| timetable.ts | 4 | 0 |
| classComments.ts | 2 | 0 |
| principalRemarks.ts | 2 | 0 |
| notices.ts | 3 | 0 |
| **total** | **163** | **13** |

- Total routes found: 163 (25 routers). Of these, 1 is not a school job (`POST /api/schools`, schools.ts:239) so **162 are school routes under `/:schoolId`**; 4 more Paystack routes are mounted under `/api/schools` before the auth chain and excluded above.
- fits: 130 yes, 15 yes after a "Changes from today" item, 3 yes with roles equal but job unnamed, 2 n/a (POST / create school; `POST /students/:id/promote`, which the spec removes), **13 NO**.
- Routes no web page calls (checked against `apps/web` outside `super-admin`; the export routes are called through a dynamic path in settings/export/page.tsx and are fine): `PATCH /users/:userId/email` (users.ts:383), `POST /students/:studentId/promote` (students.ts:762), `POST /scores/entry` (scores.ts:69), `GET /scores/my-pending` (scores.ts:308), `GET /dashboard/principal/result-status` (dashboard.ts:94), `GET /dashboard/principal/class-selector` (dashboard.ts:160), `GET /dashboard/teacher/my-students` (teacherDashboard.ts:90), `GET /parent/students/:studentId/report-card` (parent.ts:271), `GET /student/report-card` (student.ts:279). The spec's "no screen reaches" concern is real for these; each still needs a capability or a removal.

## 4. Web pages that call routes their role cannot reach, or are shown to roles that cannot use them

Mismatches only. Evidence is from reading the code, not from running the app.

1. **The principal's "Students" link bounces the principal.** `lib/navigation.ts:38` points the principal's Students item at `/registrar/students`, but `app/(dashboard)/registrar/layout.tsx:8` sets `ALLOWED_ROLES = ['registrar', 'super_admin']` and lines 15-17 and 20-22 redirect any other role to its own dashboard (git: layout unchanged since 12 Jun 2026; the nav link was added 17 Sep, 880c985). So, by the code, the principal cannot open Students, the student profile (Assign Class, transcripts, parent linking), Promotions, or import. The page itself assumes the principal reaches it: `registrar/students/page.tsx:470-476` (comment and `canSeeAcademics`) and `registrar/students/[id]/page.tsx:779` (`PrincipalRemarkCard` for principal). The API admits the principal on all of these. Check this one in the browser first.
2. **A bursar who opens Payout Setup sees the whole Settings rail.** `settings/layout.tsx:14` builds the rail from `visibleNavGroups(SETTINGS_NAV_GROUPS, [])` with no role filter, so the bursar gets links to Users, Roster, Identity, Fee Settings and the rest, whose APIs return 403 for the bursar (users.ts:90 and schools.ts:155 admit principal only). `navigation.ts:193-200` says the layout "shows every group to every role and leaves the real gate to each page", but only `settings/payout/page.tsx:50,73` and `settings/billing/page.tsx:80,90` have a page-level role guard.
3. **Fee Settings is shown to the bursar but refuses him.** Same rail (item 2): `/settings/fees` loads `GET /fee-config` (settings/fees/page.tsx:58), which is principal-only (schools.ts:692, file guard :155), and the PATCH names the bursar in `requireRole` (schools.ts:727) but the file guard refuses him first. The spec already lists this clean-up.
4. **Platform Billing is missing from the bursar's sidebar.** The API admits him (platformBilling.ts:60-61, 103-104), the page admits him (settings/billing/page.tsx:80), and the Ctrl+K palette offers it (`lib/commandPalette.ts:40`), but the sidebar renders only "Payout Setup" for the `payout` access level (`app/(dashboard)/layout.tsx:114-121`). The palette and the sidebar disagree for this role.
5. **Message notifications send a registrar or bursar to the parent area.** `components/NotificationBell.tsx:26-32` (`MESSAGES_PATH_BY_ROLE`) has no registrar or bursar entry; line 197 falls back to `/parent/messages`, and `app/(parent)/layout.tsx:203-204` redirects those roles away again. (super_admin maps to `/principal/messages`.)
6. **Registrar gaining Roster -> Classes would break on load (spec change, not yet built).** `ClassesTab` loads classes and `GET /users?role=teacher` in one `Promise.all` (settings/roster/page.tsx:239-240) and shows "Failed to load classes" if either fails (:246). `GET /users` is principal-only (users.ts:155, file guard :90). The same applies to the Teaching tab (users, teacher-assignments, all principal-only). The form-teacher picker needs a read the registrar will not have.
7. **Bursar gaining `students.view` has no page to land on (spec change, not yet built).** The only student list is `/registrar/students`, behind `registrar/layout.tsx:8`, which admits registrar and super_admin only (see item 1). BURSAR_NAV (navigation.ts:112-119) has no Students link.
8. **No page-level role guard on most dashboard areas.** Only `registrar/layout.tsx`, `(parent)/layout.tsx:203`, `(student)/layout.tsx:179`, `settings/payout` and `settings/billing` redirect by role. `/principal/*`, `/teacher/*`, `/bursar/*`, `/notices` and the other `/settings/*` pages have none (there is no `bursar`, `principal` or `teacher` layout). A role that types a URL gets the page shell and 403s from the API (e.g. a teacher on `/bursar/invoices`). The sidebar hides them; the page does not.
9. **Principal has no sidebar entry for fee data it can read, and none for what the spec gives it.** PRINCIPAL_NAV_GROUPS (navigation.ts:19-51) has no fees link; all fee screens live under `/bursar/*`. The API already lets the principal read fee structures, invoices, outstanding balances, the collection summary and receipts (fees.ts:380, 406, 478, 504, 530, 699), and the spec gives payments, refunds, import and reminders.
10. **Minor: "Class Comments" is in every teacher's sidebar** (navigation.ts:59) but `GET /class-comments` answers 404 `NOT_FORM_TEACHER` unless the teacher is a class's form teacher (classComments.ts:41-44); the page then shows an error string (teacher/class-comments/page.tsx:63).

Checked and consistent (no mismatch): no teacher page calls the student list or a student profile (spec claim holds; the only callers of `GET /students` are `registrar/students`, `registrar/promotions`, `principal/report-cards`); bursar pages call only bursar/principal routes plus the member-wide sessions, classes and current-context; `settings/payout` `canEdit` matches the API write rule (principal, super_admin); parent and student pages call only their own portal routes plus member-wide ones; `registrar/students` guards its principal-only `results/class-summary` call behind `canSeeAcademics` (page.tsx:476); `PrincipalRemarkCard` is rendered only for principal (page.tsx:779); the command palette is built from `getNavGroupsForRole` and `settingsAccessForRole` as the CLAUDE.md says.
