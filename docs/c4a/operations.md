# Operation inventory (generated — `node scripts/c4a/inventory.js`)

659 table references across 47 files; 44 of 44 tables are touched by application code.

**Known limits** — SQL is found as string literals containing SELECT / INSERT INTO /
UPDATE … SET / DELETE FROM / TRUNCATE, and identifiers are kept only if they are real
tables. Missed: SQL assembled across several separate literals, and table names held in
variables. `SELECT` is recorded for any FROM/JOIN, so a subquery counts. `UPDATE` is
added for `INSERT … ON CONFLICT DO UPDATE`, which needs that privilege.

## academic_sessions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/analytics.ts:211 | `listSchoolsWithCurrentTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:35 | `getDashboardStats` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:56 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:23 | `getLinkedChildren` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:46 | `fetchStudentReportData` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:130 | `getActiveTerm` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/sessions.ts:33 | `insertSession` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:43 | `listSessionsWithTerms` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:74 | `findSessionById` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/sessions.ts:189 | `activateSession` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/sessions.ts:194 | `activateSession` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:211 | `getCurrentContext` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:217 | `getCurrentContext` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:240 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:293 | `listStudents` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:363 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:536 | `findEnrollmentForCurrentSession` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:685 | `POST /:schoolId/students/:studentId/promote` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:850 | `POST /:schoolId/students/promote-bulk` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1448 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |

## announcements

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT ⚠ dynamic | apps/api/src/db/queries/announcements.ts:33 | `createAnnouncement` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/announcements.ts:51 | `listAnnouncementsForRole` | pool (db/client.ts) |

## assessment_components

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/analytics.ts:58 | `computeOverallPerformance` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/analytics.ts:95 | `computeSubjectPerformance` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/assessmentConfig.ts:66 | `insertAssessmentConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:90 | `listAssessmentConfigs` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:142 | `fetchConfigWithComponents` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:200 | `resolveAssessmentConfig` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/assessmentConfig.ts:242 | `updateAssessmentConfig` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/assessmentConfig.ts:249 | `updateAssessmentConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:50 | `getDashboardStats` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:227 | `getStudentsInClassWithAverages` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:409 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:51 | `getComponentInfo` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/scores.ts:264 | `POST /:schoolId/scores/bulk-entry` | pool (db/client.ts) |

## assessment_configs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/assessmentConfig.ts:56 | `insertAssessmentConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:90 | `listAssessmentConfigs` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:125 | `findConfigById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:137 | `fetchConfigWithComponents` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:175 | `resolveAssessmentConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:214 | `scoresExistForConfigTerm` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/assessmentConfig.ts:275 | `updateAssessmentConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:409 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:365 | `subjectHasReferences` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:51 | `getComponentInfo` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/scores.ts:264 | `POST /:schoolId/scores/bulk-entry` | pool (db/client.ts) |

## assignment_submissions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/assignments.ts:102 | `listAssignmentsForTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:125 | `listAssignmentsForSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:169 | `listAssignmentsForStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:226 | `listSubmissionsForAssignment` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/assignments.ts:275 | `upsertSubmission` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/assignments.ts:304 | `gradeSubmission` | pool (db/client.ts) |

## assignments

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/assignments.ts:68 | `createAssignment` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/assignments.ts:82 | `updateAssignmentAttachment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:90 | `findAssignmentById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:102 | `listAssignmentsForTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:125 | `listAssignmentsForSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:169 | `listAssignmentsForStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1851 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## attendance

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/analytics.ts:130 | `computeAttendanceSummary` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/attendance.ts:129 | `bulkUpsertAttendance` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:154 | `countRecentAbsences` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:195 | `getClassAttendanceForDate` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:231 | `getStudentAttendanceHistory` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:238 | `getStudentAttendanceHistory` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:277 | `getMonthlySummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:316 | `getClassTermSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1779 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1852 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## attendance_alerts

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/attendance.ts:165 | `hasUnresolvedAlert` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/attendance.ts:174 | `insertAttendanceAlert` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:352 | `listUnresolvedAlerts` | pool (db/client.ts) |

## audit_logs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/auditLog.ts:32 | `logAudit` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:261 | `getTeacherNotifications` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/scores.ts:304 | `bulkUpsertScores` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:646 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1779 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/services/notificationWorker.ts:103 | `processNotificationQueue` | pool (db/client.ts) |
| UPDATE (SET processed_at) | apps/api/src/services/notificationWorker.ts:115 | `processNotificationQueue` | pool (db/client.ts) |

## behaviour_records

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/behaviour.ts:57 | `createBehaviourRecord` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:108 | `getStudentIncidentCount` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:117 | `getSchoolBehaviourSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:129 | `getSchoolBehaviourSummary` | pool (db/client.ts) |

## class_teacher_comments

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/classComments.ts:32 | `listClassStudentsForComments` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/classComments.ts:59 | `upsertClassTeacherComment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:84 | `fetchClassTeacherComment` | pool (db/client.ts) |

## classes

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:168 | `resolveAssessmentConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:102 | `listAssignmentsForTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:125 | `listAssignmentsForSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:316 | `getClassTermSummary` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:129 | `getSchoolBehaviourSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/classComments.ts:20 | `findClassByFormTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:28 | `getDashboardStats` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:191 | `getTeacherScoreEntryStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:437 | `listInvoices` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notices.ts:78 | `findNoticeById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:23 | `getLinkedChildren` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:46 | `fetchStudentReportData` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:94 | `fetchFormTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:216 | `fetchClassLevel` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:341 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:16 | `findClassByName` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/roster.ts:30 | `insertClass` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/roster.ts:44 | `updateClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:54 | `listClasses` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:235 | `copyAssignmentsBetweenTerms` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:263 | `listTeacherAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:328 | `findClassById` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/roster.ts:348 | `deleteClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:405 | `listClassNamesAndIds` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:141 | `listClassLevels` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:365 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:458 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:363 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:75 | `findClassClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:97 | `findTeacherClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:128 | `getTeacherTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/results.ts:262 | `GET /:schoolId/results/class-summary` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:686 | `POST /:schoolId/students/:studentId/promote` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:859 | `POST /:schoolId/students/promote-bulk` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:779 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:179 | `fetchAcademicConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:257 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:412 | `getStudentsAtRisk` | pool (db/client.ts) |

## email_queue

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/emailQueue.ts:13 | `enqueueEmail` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/emailQueue.ts:21 | `getPendingEmails` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/emailQueue.ts:30 | `markEmailSent` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/emailQueue.ts:36 | `markEmailRetryFailed` | pool (db/client.ts) |

## fee_invoices

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT, UPDATE | apps/api/src/db/queries/fees.ts:129 | `generateInvoices` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:223 | `recordPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:246 | `recordPayment` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/fees.ts:323 | `recordPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:386 | `getInvoiceByStudent` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:437 | `listInvoices` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:456 | `getInvoiceById` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:539 | `getCollectionSummary` | pool (db/client.ts) |

## fee_structures

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/fees.ts:43 | `insertFeeStructure` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:64 | `listFeeStructures` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:110 | `generateInvoices` | pool (db/client.ts) |

## messages

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/messages.ts:146 | `createMessage` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:156 | `isThreadParticipant` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:165 | `getInbox` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:177 | `getInbox` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:193 | `getThreadMessages` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/messages.ts:207 | `markThreadRead` | pool (db/client.ts) |

## migration_runs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/scripts/migrate.ts:50 | `recordRun` | owner (migrate, DATABASE_URL) |

## notices

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/notices.ts:37 | `getNoticesForClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notices.ts:57 | `findNoticeById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notices.ts:78 | `findNoticeById` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/notices.ts:118 | `createNotice` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/notices.ts:135 | `deleteNotice` | pool (db/client.ts) |

## notification_logs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/notificationLogs.ts:14 | `insertNotificationLog` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notificationLogs.ts:24 | `hasReachedSmsLimit` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1848 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## notifications

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/notifications.ts:28 | `createNotification` | pool (db/client.ts) |
| INSERT ⚠ dynamic | apps/api/src/db/queries/notifications.ts:47 | `createNotificationsBulk` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notifications.ts:57 | `listNotifications` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notifications.ts:63 | `listNotifications` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/notifications.ts:72 | `markNotificationRead` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/notifications.ts:79 | `markAllNotificationsRead` | pool (db/client.ts) |

## onboarding_sessions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/routes/superAdmin.ts:1269 | `GET /onboarding` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1313 | `POST /onboarding` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1341 | `GET /onboarding/:sessionId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1385 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1554 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1582 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1624 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |

## parent_students

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:60 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:76 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:23 | `getLinkedChildren` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:56 | `isParentLinkedToStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:77 | `getParentsForStudent` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:230 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:373 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:39 | `checkParentStudentLink` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:974 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/students.ts:982 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:851 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/services/notificationWorker.ts:58 | `processRow` | pool (db/client.ts) |

## payments

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/fees.ts:240 | `recordPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:274 | `recordPayment` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/fees.ts:286 | `recordPayment` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/fees.ts:289 | `recordPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:395 | `getInvoiceByStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1849 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## platform_announcements

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/routes/superAdmin.ts:2001 | `POST /announcements` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:2038 | `GET /announcements` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2060 | `PATCH /announcements/:id` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/routes/superAdmin.ts:2087 | `PATCH /announcements/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2106 | `DELETE /announcements/:id` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:2115 | `DELETE /announcements/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2132 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2142 | `POST /announcements/:id/publish` | pool (db/client.ts) |

## platform_audit_logs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/routes/superAdmin.ts:403 | `POST /support-sessions` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:449 | `PATCH /support-sessions/:id/end` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:526 | `GET /audit-logs` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:696 | `PATCH /schools/:schoolId/suspend` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:753 | `PATCH /schools/:schoolId/reactivate` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:857 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1026 | `POST /subscriptions` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1081 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1129 | `POST /subscriptions/:id/extend-trial` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1168 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1321 | `POST /onboarding` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1672 | `appUrl` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1936 | `GET /health/overview` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2171 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2255 | `POST /admins` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2334 | `POST /admins/:id/resend-welcome` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2427 | `PATCH /admins/:id/suspend` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2469 | `PATCH /admins/:id/reactivate` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2522 | `DELETE /admins/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:53 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| INSERT | apps/api/src/services/subscriptionService.ts:46 | `runTrialExpiryCheck` | pool (db/client.ts) |

## platform_metrics_snapshots

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/routes/superAdmin.ts:1739 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1935 | `GET /health/overview` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/services/platformAnalyticsService.ts:62 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |

## platform_subscriptions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/platformRevenue.ts:76 | `getPlatformRevenue` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:578 | `GET /schools` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:640 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:900 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:914 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:942 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1007 | `POST /subscriptions` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1015 | `POST /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1051 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/routes/superAdmin.ts:1070 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1108 | `POST /subscriptions/:id/extend-trial` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1120 | `POST /subscriptions/:id/extend-trial` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1156 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1721 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1731 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1779 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2148 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:43 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/subscriptionService.ts:19 | `runTrialExpiryCheck` | pool (db/client.ts) |
| UPDATE | apps/api/src/services/subscriptionService.ts:41 | `runTrialExpiryCheck` | pool (db/client.ts) |

## principal_remarks

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/reportCards.ts:108 | `fetchPrincipalRemark` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/reportCards.ts:135 | `upsertPrincipalRemark` | pool (db/client.ts) |

## report_cards

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT, UPDATE | apps/api/src/db/queries/reportCards.ts:157 | `upsertReportCard` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/reportCards.ts:190 | `publishReportCards` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:203 | `getReportCardsForClass` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/parent.ts:74 | `findPublishedReportCard` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/student.ts:80 | `findPublishedReportCard` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/students.ts:750 | `GET /:schoolId/students/:studentId/report-card` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:845 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |

## result_status

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/reportCards.ts:157 | `upsertReportCard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:115 | `getStudentsInClassWithStatus` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/results.ts:209 | `batchUpsertStatuses` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/results.ts:218 | `batchUpsertStatuses` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:363 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:189 | `checkPublishedResultsExist` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:203 | `checkSubmittedResultsExist` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:66 | `getResultStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:137 | `getFinalisedStudents` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:844 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1853 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## schema_migrations

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/scripts/migrate.ts:95 | `migrate` | owner (migrate, DATABASE_URL) |
| INSERT | apps/api/src/scripts/migrate.ts:120 | `migrate` | owner (migrate, DATABASE_URL) |

## school_analytics_snapshots

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT, UPDATE | apps/api/src/db/queries/analytics.ts:165 | `upsertSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/analytics.ts:189 | `getLatestSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/analytics.ts:200 | `getPreviousSnapshot` | pool (db/client.ts) |

## school_settings

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/schools.ts:73 | `insertSchoolSettings` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:83 | `findSchoolById` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:98 | `updateIdentityConfig` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/schools.ts:124 | `updateAcademicConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:154 | `findAcademicConfig` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:165 | `updateNotificationConfig` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:178 | `updateReportConfig` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:238 | `updateFeeConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:250 | `resolveMinPartPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:125 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:639 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1222 | `ensureSchoolSettings` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:179 | `fetchAcademicConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/services/termiiService.ts:12 | `getSmsSenderName` | pool (db/client.ts) |

## schools

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/platformRevenue.ts:76 | `getPlatformRevenue` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/schools.ts:48 | `insertSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:83 | `findSchoolById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:267 | `getSchoolPayoutConfig` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:277 | `updateSchoolPayoutConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:284 | `getSchoolNameAndEmail` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/auth.ts:229 | `POST /login` | login client (routes/auth.ts getLoginClient) |
| SELECT | apps/api/src/routes/superAdmin.ts:470 | `GET /support-sessions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:526 | `GET /audit-logs` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:578 | `GET /schools` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:630 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:681 | `PATCH /schools/:schoolId/suspend` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:692 | `PATCH /schools/:schoolId/suspend` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:723 | `PATCH /schools/:schoolId/reactivate` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:749 | `PATCH /schools/:schoolId/reactivate` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:773 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:828 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:900 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:914 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1002 | `POST /subscriptions` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1022 | `POST /subscriptions` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1076 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1156 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1269 | `GET /onboarding` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1297 | `POST /onboarding` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1305 | `POST /onboarding` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1350 | `GET /onboarding/:sessionId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1394 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1407 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1597 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1620 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1713 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1714 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1716 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1721 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1731 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1736 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1779 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1844 | `GET /analytics/feature-adoption` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1886 | `GET /analytics/growth` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2148 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| SELECT | apps/api/src/services/planFeatures.ts:23 | `schoolAllowsFeature` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:39 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:40 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:51 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| UPDATE | apps/api/src/services/subscriptionService.ts:44 | `runTrialExpiryCheck` | pool (db/client.ts) |
| SELECT | apps/api/src/services/welcomeEmail.ts:4 | `getSchoolName` | pool (db/client.ts) |

## scores

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/analytics.ts:58 | `computeOverallPerformance` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/analytics.ts:95 | `computeSubjectPerformance` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:90 | `listAssessmentConfigs` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:214 | `scoresExistForConfigTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:50 | `getDashboardStats` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:135 | `getTeacherOverview` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:191 | `getTeacherScoreEntryStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:227 | `getStudentsInClassWithAverages` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:283 | `getTeacherActivity` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:162 | `checkSubjectCompletion` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:391 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:302 | `scoresExistForAssignment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:365 | `subjectHasReferences` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:153 | `getExistingScore` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/scores.ts:172 | `upsertScore` | pool (db/client.ts) |
| INSERT, SELECT, UPDATE | apps/api/src/db/queries/scores.ts:268 | `bulkUpsertScores` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:406 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:458 | `getMyPendingAssignments` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:843 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:221 | `computeStudentSubjectResult` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:312 | `computeClassResults` | pool (db/client.ts) |

## student_classes

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/assignments.ts:102 | `listAssignmentsForTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:125 | `listAssignmentsForSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:226 | `listSubmissionsForAssignment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:57 | `getClassRoster` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:195 | `getClassAttendanceForDate` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:277 | `getMonthlySummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/classComments.ts:32 | `listClassStudentsForComments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/classComments.ts:46 | `findStudentClassForTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:135 | `getTeacherOverview` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:191 | `getTeacherScoreEntryStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:227 | `getStudentsInClassWithAverages` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:119 | `generateInvoices` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:437 | `listInvoices` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:528 | `getCollectionSummary` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:60 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:76 | `(module)` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:94 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:23 | `getLinkedChildren` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:46 | `fetchStudentReportData` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:203 | `getReportCardsForClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:115 | `getStudentsInClassWithStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:148 | `checkSubjectCompletion` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:363 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:302 | `scoresExistForAssignment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:336 | `classHasReferences` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:392 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:458 | `getMyPendingAssignments` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:246 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:363 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:509 | `findEnrollmentForSession` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:521 | `insertStudentClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:536 | `findEnrollmentForCurrentSession` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/students.ts:548 | `updateEnrollmentClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:164 | `getStudentClassIds` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:779 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:847 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:197 | `getStudentClassId` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:265 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:412 | `getStudentsAtRisk` | pool (db/client.ts) |

## students

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/analytics.ts:54 | `computeOverallPerformance` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:226 | `listSubmissionsForAssignment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:57 | `getClassRoster` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:195 | `getClassAttendanceForDate` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:277 | `getMonthlySummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:352 | `listUnresolvedAlerts` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:129 | `getSchoolBehaviourSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/classComments.ts:32 | `listClassStudentsForComments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:28 | `getDashboardStats` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:227 | `getStudentsInClassWithAverages` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:119 | `generateInvoices` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:437 | `listInvoices` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:60 | `(module)` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:94 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:23 | `getLinkedChildren` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:56 | `isParentLinkedToStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:46 | `fetchStudentReportData` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:115 | `getStudentsInClassWithStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:148 | `checkSubjectCompletion` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:363 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:392 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:131 | `registerStudent` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:187 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:355 | `getStudentProfile` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/students.ts:427 | `updateStudentBio` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/students.ts:441 | `updateStudentBio` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/students.ts:464 | `updateStudentPhotoUrl` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:484 | `findStudentById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:496 | `findStudentByUserId` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:536 | `findEnrollmentForCurrentSession` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:577 | `findStudentsByAdmissionNumbers` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:164 | `getStudentClassIds` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:39 | `checkParentStudentLink` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:566 | `GET /:schoolId/students/:studentId` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:592 | `GET /schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:779 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:847 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:851 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:854 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1716 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1892 | `GET /analytics/growth` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:41 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:265 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:412 | `getStudentsAtRisk` | pool (db/client.ts) |

## subject_result_status

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/dashboard.ts:135 | `getTeacherOverview` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:191 | `getTeacherScoreEntryStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:283 | `getTeacherActivity` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:241 | `getClassSubjectStatuses` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/results.ts:258 | `markSubjectSubmitted` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/results.ts:281 | `returnSubjectsToDraft` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:399 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:203 | `checkSubmittedResultsExist` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:122 | `getSubjectSubmissionStatus` | pool (db/client.ts) |

## subjects

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/analytics.ts:95 | `computeSubjectPerformance` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:90 | `listAssessmentConfigs` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:102 | `listAssignmentsForTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:125 | `listAssignmentsForSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:169 | `listAssignmentsForStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:191 | `getTeacherScoreEntryStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:298 | `getClassSubjectAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:376 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:75 | `findSubjectByCode` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/roster.ts:87 | `insertSubject` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/roster.ts:101 | `updateSubject` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:111 | `listActiveSubjects` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:235 | `copyAssignmentsBetweenTerms` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:263 | `listTeacherAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:357 | `findSubjectById` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/roster.ts:379 | `deleteSubject` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:417 | `listSubjectCodesAndIds` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:369 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:458 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:75 | `findClassClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:97 | `findTeacherClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:113 | `getClassTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:128 | `getTeacherTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:275 | `computeClassResults` | pool (db/client.ts) |

## support_sessions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/middleware/detectSupportSession.ts:67 | `detectSupportSession` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:356 | `POST /support-sessions` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:424 | `PATCH /support-sessions/:id/end` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:470 | `GET /support-sessions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1934 | `GET /health/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2363 | `terminateActiveSupportSessions` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2379 | `terminateActiveSupportSessions` | pool (db/client.ts) |

## teacher_assignments

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/attendance.ts:79 | `isTeacherAssignedToClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:100 | `isTeacherAssignedToClassAnyTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:135 | `getTeacherOverview` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:191 | `getTeacherScoreEntryStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:283 | `getTeacherActivity` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:60 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:76 | `(module)` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:94 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:298 | `getClassSubjectAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:320 | `getTeachersForClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:341 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:376 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:170 | `findDuplicateAssignment` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/roster.ts:185 | `insertTeacherAssignment` | pool (db/client.ts) |
| INSERT, SELECT | apps/api/src/db/queries/roster.ts:209 | `insertTeacherAssignmentsBulk` | pool (db/client.ts) |
| INSERT, SELECT | apps/api/src/db/queries/roster.ts:235 | `copyAssignmentsBetweenTerms` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:263 | `listTeacherAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:287 | `findAssignmentById` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/roster.ts:319 | `deleteTeacherAssignment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:336 | `classHasReferences` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:365 | `subjectHasReferences` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:39 | `checkTeacherAssigned` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:458 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/assignments.ts:152 | `POST /:schoolId/assignments` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/results.ts:114 | `POST /:schoolId/results/submit` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/teacherDashboard.ts:113 | `GET /:schoolId/dashboard/teacher/my-students` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:275 | `computeClassResults` | pool (db/client.ts) |

## terms

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/analytics.ts:211 | `listSchoolsWithCurrentTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assessmentConfig.ts:90 | `listAssessmentConfigs` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:45 | `findTermForDate` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:129 | `getSchoolBehaviourSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:35 | `getDashboardStats` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:135 | `getTeacherOverview` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:191 | `getTeacherScoreEntryStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:227 | `getStudentsInClassWithAverages` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:100 | `generateInvoices` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:437 | `listInvoices` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:46 | `fetchStudentReportData` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:115 | `getStudentsInClassWithStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:148 | `checkSubjectCompletion` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:352 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:130 | `getActiveTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:373 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:458 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:43 | `listSessionsWithTerms` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/sessions.ts:90 | `insertTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:102 | `listTermsBySession` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/sessions.ts:138 | `updateTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:152 | `findTermById` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/sessions.ts:166 | `activateTerm` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/sessions.ts:171 | `activateTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:217 | `getCurrentContext` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/results.ts:263 | `GET /:schoolId/results/class-summary` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/roster.ts:498 | `POST /:schoolId/teacher-assignments/copy-from-term` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1458 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:197 | `getStudentClassId` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:261 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:265 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:412 | `getStudentsAtRisk` | pool (db/client.ts) |

## timetable_slots

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/timetable.ts:59 | `insertSlot` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:75 | `findClassClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:97 | `findTeacherClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:113 | `getClassTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:128 | `getTeacherTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:143 | `findSlotById` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/timetable.ts:152 | `deleteSlot` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1850 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## users

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT ⚠ dynamic | apps/api/src/db/queries/announcements.ts:33 | `createAnnouncement` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/announcements.ts:51 | `listAnnouncementsForRole` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/announcements.ts:69 | `getTargetUsers` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:226 | `listSubmissionsForAssignment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:57 | `getClassRoster` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:195 | `getClassAttendanceForDate` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:277 | `getMonthlySummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:352 | `listUnresolvedAlerts` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:129 | `getSchoolBehaviourSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/classComments.ts:32 | `listClassStudentsForComments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:28 | `getDashboardStats` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:82 | `getUserName` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:135 | `getTeacherOverview` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:227 | `getStudentsInClassWithAverages` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:283 | `getTeacherActivity` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:437 | `listInvoices` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:491 | `getOutstandingBalances` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:60 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:76 | `(module)` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:94 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:109 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:117 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:165 | `getInbox` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:193 | `getThreadMessages` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notices.ts:78 | `findNoticeById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:23 | `getLinkedChildren` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:56 | `isParentLinkedToStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:77 | `getParentsForStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:46 | `fetchStudentReportData` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:94 | `fetchFormTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:115 | `getStudentsInClassWithStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:148 | `checkSubjectCompletion` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:298 | `getClassSubjectAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:320 | `getTeachersForClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:363 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:376 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:235 | `copyAssignmentsBetweenTerms` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:259 | `listTeacherAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/roster.ts:394 | `findTeachersByEmails` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:61 | `schoolHasPrincipal` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:392 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:151 | `registerStudent` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:178 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:205 | `registerStudent` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:220 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:355 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:373 | `getStudentProfile` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/students.ts:441 | `updateStudentBio` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:559 | `findUsersRolesByEmails` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:577 | `findStudentsByAdmissionNumbers` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:75 | `findClassClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:97 | `findTeacherClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:113 | `getClassTimetable` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/users.ts:80 | `findUserById` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/users.ts:88 | `findUserByEmail` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/users.ts:96 | `updatePasswordHash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/users.ts:104 | `getPasswordHashById` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/users.ts:128 | `changeOwnPassword` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/users.ts:174 | `reassignUserEmail` | pool (db/client.ts) |
| INSERT ⚠ dynamic | apps/api/src/db/queries/users.ts:216 | `insertUser` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/users.ts:243 | `updateUserProfile` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/users.ts:255 | `updateUserSignature` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/users.ts:264 | `setUserActive` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/users.ts:274 | `findPrincipalsBySchool` | pool (db/client.ts) |
| SELECT | apps/api/src/middleware/auth.ts:95 | `verifyToken` | pool (db/client.ts) |
| SELECT | apps/api/src/middleware/auth.ts:100 | `verifyToken` | pool (db/client.ts) |
| SELECT | apps/api/src/middleware/auth.ts:144 | `requirePasswordChanged` | pool (db/client.ts) |
| SELECT | apps/api/src/middleware/auth.ts:149 | `requirePasswordChanged` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/auth.ts:87 | `POST /create-user` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/auth.ts:115 | `POST /create-user` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/auth.ts:210 | `POST /login` | login client (routes/auth.ts getLoginClient) |
| UPDATE | apps/api/src/routes/auth.ts:226 | `POST /login` | login client (routes/auth.ts getLoginClient) |
| INSERT, UPDATE | apps/api/src/routes/auth.ts:310 | `POST /seed-test-user` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:935 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/students.ts:967 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:343 | `POST /support-sessions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:470 | `GET /support-sessions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:526 | `GET /audit-logs` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:642 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:779 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1513 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1532 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1606 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1892 | `GET /analytics/growth` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:2038 | `GET /announcements` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2148 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2200 | `GET /admins` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2249 | `POST /admins` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2300 | `POST /admins/:id/resend-welcome` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2352 | `countOtherActiveAdmins` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2398 | `PATCH /admins/:id/suspend` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2415 | `PATCH /admins/:id/suspend` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2452 | `PATCH /admins/:id/reactivate` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2466 | `PATCH /admins/:id/reactivate` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2507 | `DELETE /admins/:id` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2534 | `DELETE /admins/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/scripts/seedSuperAdmin.ts:19 | `main` | pool (db/client.ts) |
| INSERT | apps/api/src/scripts/seedSuperAdmin.ts:40 | `main` | pool (db/client.ts) |
| SELECT | apps/api/src/services/notificationWorker.ts:58 | `processRow` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:265 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/subscriptionService.ts:12 | `getSystemAdminId` | pool (db/client.ts) |

## Tables no application code touches

