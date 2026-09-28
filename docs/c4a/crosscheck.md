# C-4a cross-check (generated — `node scripts/c4a/crosscheck.js`)

`operations.json` (every SQL statement found in `apps/api/src`) against
`effective_privileges.json` (what `information_schema` reports `chronixedu_app` holds
after `grants.sql`, on a local rebuild).

## 1. Used by the app but NOT granted — 0

None. Every statement the inventory found on the app pool and the login client is covered by the grant set, including the single `audit_logs` UPDATE (column `processed_at` only, which is exactly the column-level grant).

**This is necessary, not sufficient.** It can only see SQL the inventory found. The
62 app-connection references below are statements assembled with
`${…}` interpolation — the table was found, but a conditional JOIN or a fragment held in
a variable could hide another. They are the first place a second reader should look.

## 2. Granted but never used by the app — 40 privileges on 33 tables

Candidates for narrowing after cutover — **not** removed here. The plan is DML-broad on
purpose so the cutover fails on nothing; narrowing is a separate, per-table change, each
one probed like the REVOKEs above.

| Table | Granted, unused |
|---|---|
| academic_sessions | DELETE |
| announcements | DELETE, UPDATE |
| assessment_components | UPDATE |
| assessment_configs | DELETE |
| assignment_submissions | DELETE |
| assignments | DELETE |
| attendance | DELETE |
| attendance_alerts | DELETE, UPDATE |
| behaviour_records | DELETE, UPDATE |
| class_teacher_comments | DELETE |
| email_queue | DELETE |
| fee_invoices | DELETE |
| fee_structures | DELETE, UPDATE |
| messages | DELETE |
| notices | UPDATE |
| notification_logs | DELETE, UPDATE |
| notifications | DELETE |
| onboarding_sessions | DELETE |
| parent_students | UPDATE |
| payments | DELETE, UPDATE |
| platform_audit_logs | DELETE, UPDATE |
| platform_metrics_snapshots | DELETE |
| platform_subscriptions | DELETE |
| principal_remarks | DELETE |
| school_analytics_snapshots | DELETE |
| school_settings | DELETE |
| schools | DELETE |
| subject_result_status | DELETE |
| support_sessions | DELETE |
| teacher_assignments | UPDATE |
| terms | DELETE |
| timetable_slots | UPDATE |
| users | DELETE |

## 3. The login client (routes/auth.ts) — 5 statements

The plan gives this its own `AUTH_DATABASE_URL`. Whichever role that names needs:

- SELECT on `users` — apps/api/src/routes/auth.ts:73
- INSERT on `users` — apps/api/src/routes/auth.ts:101
- SELECT on `users` — apps/api/src/routes/auth.ts:198
- UPDATE on `users` — apps/api/src/routes/auth.ts:214
- INSERT, UPDATE on `users` — apps/api/src/routes/auth.ts:300

**Open, unmeasured:** `getPgClient()` builds `new Client({ connectionString })` with no
`ssl` option, bypassing `resolveSsl()` — the function that makes the pool TLS-verified
by default. Whether logins travel over verified TLS therefore depends on what the
connection string says. Not asserted either way until measured; step 5 of the plan is
where it gets fixed.

## 4. Owner-only — 3 statements

- INSERT on `migration_runs` — apps/api/src/scripts/migrate.ts:50 (owner (migrate, DATABASE_URL))
- SELECT on `schema_migrations` — apps/api/src/scripts/migrate.ts:95 (owner (migrate, DATABASE_URL))
- INSERT on `schema_migrations` — apps/api/src/scripts/migrate.ts:120 (owner (migrate, DATABASE_URL))

## 5. Assembled statements to review by hand — 62

| Table | Ops | Where | Function |
|---|---|---|---|
| announcements | INSERT | apps/api/src/db/queries/announcements.ts:33 | `createAnnouncement` |
| announcements | SELECT | apps/api/src/db/queries/announcements.ts:51 | `listAnnouncementsForRole` |
| assessment_configs | UPDATE | apps/api/src/db/queries/assessmentConfig.ts:275 | `updateAssessmentConfig` |
| audit_logs | SELECT | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` |
| behaviour_records | SELECT | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` |
| classes | SELECT | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` |
| classes | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| classes | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| fee_invoices | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| fee_invoices | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| fee_invoices | SELECT | apps/api/src/db/queries/fees.ts:539 | `getCollectionSummary` |
| fee_structures | SELECT | apps/api/src/db/queries/fees.ts:64 | `listFeeStructures` |
| notifications | INSERT | apps/api/src/db/queries/notifications.ts:47 | `createNotificationsBulk` |
| parent_students | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| platform_announcements | SELECT | apps/api/src/routes/superAdmin.ts:2038 | `GET /announcements` |
| platform_announcements | UPDATE | apps/api/src/routes/superAdmin.ts:2087 | `PATCH /announcements/:id` |
| platform_audit_logs | SELECT | apps/api/src/routes/superAdmin.ts:526 | `GET /audit-logs` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:578 | `GET /schools` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:900 | `GET /subscriptions` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:914 | `GET /subscriptions` |
| platform_subscriptions | UPDATE | apps/api/src/routes/superAdmin.ts:1070 | `PATCH /subscriptions/:id` |
| report_cards | SELECT | apps/api/src/routes/students.ts:750 | `GET /:schoolId/students/:studentId/report-card` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:526 | `GET /audit-logs` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:578 | `GET /schools` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:900 | `GET /subscriptions` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:914 | `GET /subscriptions` |
| student_classes | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| student_classes | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| student_classes | SELECT | apps/api/src/db/queries/fees.ts:528 | `getCollectionSummary` |
| student_classes | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| student_classes | SELECT | apps/api/src/db/queries/messages.ts:94 | `(module)` |
| students | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| students | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| students | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| students | SELECT | apps/api/src/db/queries/messages.ts:94 | `(module)` |
| students | UPDATE | apps/api/src/db/queries/students.ts:427 | `updateStudentBio` |
| students | SELECT | apps/api/src/db/queries/students.ts:441 | `updateStudentBio` |
| students | SELECT | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` |
| teacher_assignments | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| teacher_assignments | SELECT | apps/api/src/db/queries/messages.ts:94 | `(module)` |
| terms | SELECT | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` |
| terms | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| terms | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| terms | UPDATE | apps/api/src/db/queries/sessions.ts:138 | `updateTerm` |
| users | SELECT | apps/api/src/db/queries/announcements.ts:33 | `createAnnouncement` |
| users | SELECT | apps/api/src/db/queries/announcements.ts:51 | `listAnnouncementsForRole` |
| users | SELECT | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` |
| users | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| users | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| users | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| users | SELECT | apps/api/src/db/queries/messages.ts:94 | `(module)` |
| users | UPDATE | apps/api/src/db/queries/students.ts:441 | `updateStudentBio` |
| users | SELECT | apps/api/src/db/queries/users.ts:80 | `findUserById` |
| users | SELECT | apps/api/src/db/queries/users.ts:88 | `findUserByEmail` |
| users | UPDATE | apps/api/src/db/queries/users.ts:174 | `reassignUserEmail` |
| users | INSERT | apps/api/src/db/queries/users.ts:216 | `insertUser` |
| users | UPDATE | apps/api/src/db/queries/users.ts:243 | `updateUserProfile` |
| users | UPDATE | apps/api/src/db/queries/users.ts:264 | `setUserActive` |
| users | SELECT | apps/api/src/routes/superAdmin.ts:526 | `GET /audit-logs` |
| users | SELECT | apps/api/src/routes/superAdmin.ts:2038 | `GET /announcements` |
