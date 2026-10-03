# C-4a cross-check (generated — `node scripts/c4a/crosscheck.js`)

`operations.json` (every SQL statement found in `apps/api/src`) against
`effective_privileges.json` (what `information_schema` reports `chronixedu_app` holds
after `grants.sql`, on a local rebuild).

## 1. Used by the app but NOT granted — 0

None. Every statement the inventory found on the app pool and the login client is covered by the grant set, including the single `audit_logs` UPDATE (column `processed_at` only, which is exactly the column-level grant).

**This is necessary, not sufficient.** It can only see SQL the inventory found. The
71 app-connection references below are statements assembled with
`${…}` interpolation — the table was found, but a conditional JOIN or a fragment held in
a variable could hide another. They are the first place a second reader should look.

## 2. Granted but never used by the app — 59 privileges on 37 tables

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
| fee_invoices | DELETE |
| fee_structures | DELETE, UPDATE |
| login_challenges | DELETE, INSERT, SELECT, UPDATE |
| messages | DELETE |
| notices | UPDATE |
| notification_logs | DELETE, UPDATE |
| notifications | DELETE |
| onboarding_sessions | DELETE |
| parent_students | UPDATE |
| payments | DELETE, UPDATE |
| platform_audit_logs | DELETE, UPDATE |
| platform_metrics_snapshots | DELETE |
| platform_pricing_config | DELETE, INSERT, SELECT, UPDATE |
| platform_subscription_payments | DELETE, INSERT, SELECT, UPDATE |
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
| user_recovery_codes | DELETE, INSERT, SELECT, UPDATE |
| user_totp | DELETE, INSERT, SELECT, UPDATE |
| users | DELETE |

## 3. The login connection (routes/auth.ts, POST /login only) — 4 statements

Checked above against `chronixedu_login`, its own column-scoped role — not the app role.
It serves the one path reaching the database for an unauthenticated caller, so it holds
only what that path reads and stamps:

- SELECT on `schools` — apps/api/src/routes/auth.ts:161
- UPDATE on `users` — apps/api/src/routes/auth.ts:157
- SELECT on `users` — apps/api/src/routes/auth.ts:239
- SELECT on `users` — apps/api/src/routes/auth.ts:326

Granted (from information_schema): INSERT login_challenges.challenge_hash; INSERT login_challenges.expires_at; INSERT login_challenges.ip_address; INSERT login_challenges.user_id; SELECT login_challenges.attempts; SELECT login_challenges.challenge_hash; SELECT login_challenges.consumed_at; SELECT login_challenges.expires_at; SELECT login_challenges.id; SELECT login_challenges.user_id; UPDATE login_challenges.attempts; UPDATE login_challenges.consumed_at; INSERT platform_audit_logs.action_type; INSERT platform_audit_logs.ip_address; INSERT platform_audit_logs.metadata; INSERT platform_audit_logs.platform_admin_id; INSERT platform_audit_logs.target_school_id; INSERT platform_audit_logs.target_user_id; SELECT schools.id; SELECT schools.subscription_tier; SELECT user_recovery_codes.code_hash; SELECT user_recovery_codes.used_at; SELECT user_recovery_codes.user_id; UPDATE user_recovery_codes.used_at; SELECT user_totp.activated_at; SELECT user_totp.failed_attempts; SELECT user_totp.last_used_step; SELECT user_totp.locked_until; SELECT user_totp.secret_ciphertext; SELECT user_totp.user_id; UPDATE user_totp.failed_attempts; UPDATE user_totp.last_used_step; UPDATE user_totp.locked_until; SELECT users.email; SELECT users.first_name; SELECT users.id; SELECT users.is_active; SELECT users.last_name; SELECT users.must_change_password; SELECT users.role; SELECT users.school_id; SELECT users.support_code; SELECT users.title; UPDATE users.last_login_at.

`/create-user` and `/seed-test-user` used this client too; they sit behind super_admin
auth / are off in production, and moved to the app pool so the login role needs no
INSERT on users. **TLS:** the client now takes `ssl` from `resolveSsl()` like the pool, and
logs its own `pg_tls_verified` line (`connection: "login"`). It had no `ssl` option at
all, so its TLS was whatever the URL implied while the boot log described the pool only.

## 4. Owner-only — 3 statements

- INSERT on `migration_runs` — apps/api/src/scripts/migrate.ts:50 (owner (migrate, DATABASE_URL))
- SELECT on `schema_migrations` — apps/api/src/scripts/migrate.ts:95 (owner (migrate, DATABASE_URL))
- INSERT on `schema_migrations` — apps/api/src/scripts/migrate.ts:120 (owner (migrate, DATABASE_URL))

## 5. Assembled statements to review by hand — 71

| Table | Ops | Where | Function |
|---|---|---|---|
| announcements | INSERT | apps/api/src/db/queries/announcements.ts:33 | `createAnnouncement` |
| announcements | SELECT | apps/api/src/db/queries/announcements.ts:51 | `listAnnouncementsForRole` |
| assessment_configs | UPDATE | apps/api/src/db/queries/assessmentConfig.ts:275 | `updateAssessmentConfig` |
| audit_logs | SELECT | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` |
| behaviour_records | SELECT | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` |
| class_teacher_comments | SELECT | apps/api/src/db/queries/schoolExport.ts:60 | `(module)` |
| classes | SELECT | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` |
| classes | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| classes | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| fee_invoices | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| fee_invoices | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| fee_invoices | SELECT | apps/api/src/db/queries/fees.ts:539 | `getCollectionSummary` |
| fee_structures | SELECT | apps/api/src/db/queries/fees.ts:64 | `listFeeStructures` |
| notifications | INSERT | apps/api/src/db/queries/notifications.ts:47 | `createNotificationsBulk` |
| parent_students | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| parent_students | SELECT | apps/api/src/db/queries/schoolExport.ts:40 | `(module)` |
| platform_announcements | SELECT | apps/api/src/routes/superAdmin.ts:2367 | `GET /announcements` |
| platform_announcements | UPDATE | apps/api/src/routes/superAdmin.ts:2416 | `PATCH /announcements/:id` |
| platform_audit_logs | SELECT | apps/api/src/routes/superAdmin.ts:584 | `GET /audit-logs` |
| platform_subscriptions | SELECT | apps/api/src/db/queries/platformBilling.ts:51 | `findBillableSubscription` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:636 | `GET /schools` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:701 | `GET /schools/:schoolId` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:964 | `GET /subscriptions` |
| platform_subscriptions | SELECT | apps/api/src/routes/superAdmin.ts:978 | `GET /subscriptions` |
| platform_subscriptions | UPDATE | apps/api/src/routes/superAdmin.ts:1405 | `PATCH /subscriptions/:id` |
| principal_remarks | SELECT | apps/api/src/db/queries/schoolExport.ts:62 | `(module)` |
| report_cards | SELECT | apps/api/src/routes/students.ts:774 | `GET /:schoolId/students/:studentId/report-card` |
| report_cards | SELECT | apps/api/src/services/schoolExportArchive.ts:62 | `(module)` |
| school_settings | SELECT | apps/api/src/db/queries/schools.ts:171 | `mergeSettingsColumn` |
| school_settings | UPDATE | apps/api/src/db/queries/schools.ts:175 | `mergeSettingsColumn` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:584 | `GET /audit-logs` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:636 | `GET /schools` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:964 | `GET /subscriptions` |
| schools | SELECT | apps/api/src/routes/superAdmin.ts:978 | `GET /subscriptions` |
| student_classes | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| student_classes | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| student_classes | SELECT | apps/api/src/db/queries/fees.ts:528 | `getCollectionSummary` |
| student_classes | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| student_classes | SELECT | apps/api/src/db/queries/messages.ts:94 | `(module)` |
| student_classes | SELECT | apps/api/src/db/queries/schoolExport.ts:47 | `(module)` |
| students | SELECT | apps/api/src/db/queries/fees.ts:437 | `listInvoices` |
| students | SELECT | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` |
| students | SELECT | apps/api/src/db/queries/messages.ts:60 | `(module)` |
| students | SELECT | apps/api/src/db/queries/messages.ts:94 | `(module)` |
| students | UPDATE | apps/api/src/db/queries/students.ts:427 | `updateStudentBio` |
| students | SELECT | apps/api/src/db/queries/students.ts:441 | `updateStudentBio` |
| students | SELECT | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` |
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
| users | SELECT | apps/api/src/routes/superAdmin.ts:584 | `GET /audit-logs` |
| users | SELECT | apps/api/src/routes/superAdmin.ts:2367 | `GET /announcements` |
