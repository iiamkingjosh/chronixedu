# Operation inventory (generated — `node scripts/c4a/inventory.js`)

729 table references across 54 files; 44 of 44 tables are touched by application code.

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:42 | `(module)` | pool (db/client.ts) |
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
| SELECT | apps/api/src/routes/students.ts:709 | `POST /:schoolId/students/:studentId/promote` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:875 | `POST /:schoolId/students/promote-bulk` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1157 | `GET /pricing/preview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1256 | `GET /schools/:id/billing-preview` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1801 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |

## announcements

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT ⚠ dynamic | apps/api/src/db/queries/announcements.ts:33 | `createAnnouncement` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/announcements.ts:51 | `listAnnouncementsForRole` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:70 | `(module)` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:53 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:51 | `getComponentInfo` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/scores.ts:266 | `POST /:schoolId/scores/bulk-entry` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:51 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:53 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:51 | `getComponentInfo` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/scores.ts:266 | `POST /:schoolId/scores/bulk-entry` | pool (db/client.ts) |

## assignment_submissions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/assignments.ts:102 | `listAssignmentsForTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:125 | `listAssignmentsForSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:169 | `listAssignmentsForStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:226 | `listSubmissionsForAssignment` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/assignments.ts:275 | `upsertSubmission` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/assignments.ts:304 | `gradeSubmission` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:67 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:66 | `(module)` | pool (db/client.ts) |

## assignments

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/assignments.ts:68 | `createAssignment` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/assignments.ts:82 | `updateAssignmentAttachment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:90 | `findAssignmentById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:102 | `listAssignmentsForTeacher` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:125 | `listAssignmentsForSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/assignments.ts:169 | `listAssignmentsForStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:65 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:67 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2180 | `GET /analytics/feature-adoption` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:64 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:66 | `(module)` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:63 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2107 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2181 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## attendance_alerts

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/attendance.ts:165 | `hasUnresolvedAlert` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/attendance.ts:174 | `insertAttendanceAlert` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/attendance.ts:352 | `listUnresolvedAlerts` | pool (db/client.ts) |

## audit_logs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/auditLog.ts:41 | `logAudit` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/dashboard.ts:261 | `getTeacherNotifications` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:76 | `(module)` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/scores.ts:306 | `bulkUpsertScores` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:710 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2107 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/services/notificationWorker.ts:114 | `processNotificationQueue` | pool (db/client.ts) |
| UPDATE (SET processed_at) | apps/api/src/services/notificationWorker.ts:128 | `processNotificationQueue` | pool (db/client.ts) |

## behaviour_records

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/behaviour.ts:57 | `createBehaviourRecord` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/behaviour.ts:92 | `getStudentBehaviourHistory` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:108 | `getStudentIncidentCount` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:117 | `getSchoolBehaviourSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/behaviour.ts:129 | `getSchoolBehaviourSummary` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:64 | `(module)` | pool (db/client.ts) |

## class_teacher_comments

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/classComments.ts:32 | `listClassStudentsForComments` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/classComments.ts:59 | `upsertClassTeacherComment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:84 | `fetchClassTeacherComment` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/schoolExport.ts:60 | `(module)` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:44 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:197 | `listClassLevels` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:368 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:461 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:363 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:75 | `findClassClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:97 | `findTeacherClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:128 | `getTeacherTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/results.ts:265 | `GET /:schoolId/results/class-summary` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:710 | `POST /:schoolId/students/:studentId/promote` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:884 | `POST /:schoolId/students/promote-bulk` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:843 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:179 | `fetchAcademicConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:267 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:422 | `getStudentsAtRisk` | pool (db/client.ts) |

## email_queue

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/emailQueue.ts:13 | `enqueueEmail` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/emailQueue.ts:21 | `getPendingEmails` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/emailQueue.ts:33 | `deleteQueuedEmailsOlderThan` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/emailQueue.ts:43 | `markEmailSent` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/emailQueue.ts:49 | `markEmailRetryFailed` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:73 | `(module)` | pool (db/client.ts) |

## fee_structures

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/fees.ts:43 | `insertFeeStructure` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/fees.ts:64 | `listFeeStructures` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:110 | `generateInvoices` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:72 | `(module)` | pool (db/client.ts) |

## messages

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/messages.ts:146 | `createMessage` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:156 | `isThreadParticipant` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:165 | `getInbox` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:177 | `getInbox` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:193 | `getThreadMessages` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/messages.ts:207 | `markThreadRead` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:71 | `(module)` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:69 | `(module)` | pool (db/client.ts) |

## notification_logs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/notificationLogs.ts:14 | `insertNotificationLog` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/notificationLogs.ts:24 | `hasReachedSmsLimit` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2177 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

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
| SELECT | apps/api/src/routes/superAdmin.ts:1630 | `GET /onboarding` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1674 | `POST /onboarding` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1702 | `GET /onboarding/:sessionId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1746 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1861 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1889 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1975 | `principalEmail` | pool (db/client.ts) |

## parent_students

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT ⚠ dynamic | apps/api/src/db/queries/messages.ts:60 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/messages.ts:76 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:23 | `getLinkedChildren` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:56 | `isParentLinkedToStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/parents.ts:77 | `getParentsForStudent` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/schoolExport.ts:40 | `(module)` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:230 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:373 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:39 | `checkParentStudentLink` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:1001 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/students.ts:1009 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:915 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/services/notificationWorker.ts:59 | `processRow` | pool (db/client.ts) |

## payments

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/fees.ts:240 | `recordPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:274 | `recordPayment` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/fees.ts:286 | `recordPayment` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/fees.ts:289 | `recordPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:358 | `getPaymentById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/fees.ts:395 | `getInvoiceByStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:74 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2178 | `GET /analytics/feature-adoption` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:92 | `(module)` | pool (db/client.ts) |

## platform_announcements

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/routes/superAdmin.ts:2330 | `POST /announcements` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:2367 | `GET /announcements` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2389 | `PATCH /announcements/:id` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/routes/superAdmin.ts:2416 | `PATCH /announcements/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2435 | `DELETE /announcements/:id` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:2444 | `DELETE /announcements/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2461 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2471 | `POST /announcements/:id/publish` | pool (db/client.ts) |

## platform_audit_logs

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT | apps/api/src/db/queries/platformAudit.ts:23 | `logPlatformAudit` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:461 | `POST /support-sessions` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:507 | `PATCH /support-sessions/:id/end` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:584 | `GET /audit-logs` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:760 | `PATCH /schools/:schoolId/suspend` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:817 | `PATCH /schools/:schoolId/reactivate` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:921 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1092 | `GET /pricing` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1220 | `PUT /pricing` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1335 | `POST /subscriptions` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1422 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1480 | `POST /subscriptions/:id/extend-trial` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1548 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1682 | `POST /onboarding` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1945 | `principalEmail` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2003 | `firstName` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2265 | `GET /health/overview` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2504 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2614 | `POST /admins` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2670 | `POST /admins/:id/resend-welcome` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2738 | `PATCH /admins/:id/suspend` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2781 | `PATCH /admins/:id/reactivate` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2835 | `DELETE /admins/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:53 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| INSERT | apps/api/src/services/subscriptionService.ts:83 | `audit` | pool (db/client.ts) |

## platform_metrics_snapshots

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/routes/superAdmin.ts:2067 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2264 | `GET /health/overview` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/services/platformAnalyticsService.ts:62 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |

## platform_subscriptions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT ⚠ dynamic | apps/api/src/db/queries/platformBilling.ts:51 | `findBillableSubscription` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/platformBilling.ts:197 | `settlePayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/platformRevenue.ts:82 | `getPlatformRevenue` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:87 | `findSchoolById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:352 | `findSubscriptionGate` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:636 | `GET /schools` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:701 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:964 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:978 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1005 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1157 | `GET /pricing/preview` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1218 | `PUT /pricing` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1309 | `POST /subscriptions` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1319 | `POST /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1360 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/routes/superAdmin.ts:1405 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1449 | `POST /subscriptions/:id/extend-trial` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1464 | `POST /subscriptions/:id/extend-trial` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1507 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1540 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2059 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2107 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2477 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| SELECT | apps/api/src/services/planFeatures.ts:60 | `schoolAllowsFeature` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:43 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/subscriptionService.ts:51 | `runTrialExpiryCheck` | pool (db/client.ts) |
| UPDATE | apps/api/src/services/subscriptionService.ts:93 | `audit` | pool (db/client.ts) |
| UPDATE | apps/api/src/services/subscriptionService.ts:98 | `audit` | pool (db/client.ts) |

## principal_remarks

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/reportCards.ts:108 | `fetchPrincipalRemark` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/reportCards.ts:135 | `upsertPrincipalRemark` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/schoolExport.ts:62 | `(module)` | pool (db/client.ts) |

## report_cards

| Ops | Where | Function | Connection |
|---|---|---|---|
| INSERT, UPDATE | apps/api/src/db/queries/reportCards.ts:157 | `upsertReportCard` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/reportCards.ts:190 | `publishReportCards` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/reportCards.ts:203 | `getReportCardsForClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:58 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/parent.ts:74 | `findPublishedReportCard` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/student.ts:80 | `findPublishedReportCard` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/students.ts:774 | `GET /:schoolId/students/:studentId/report-card` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:909 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/services/schoolExportArchive.ts:62 | `(module)` | pool (db/client.ts) |

## result_status

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/reportCards.ts:157 | `upsertReportCard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:115 | `getStudentsInClassWithStatus` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/results.ts:209 | `batchUpsertStatuses` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/results.ts:218 | `batchUpsertStatuses` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/results.ts:363 | `getApprovalDashboard` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:57 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:245 | `checkPublishedResultsExist` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:259 | `checkSubmittedResultsExist` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:66 | `getResultStatus` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:137 | `getFinalisedStudents` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:908 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2182 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:75 | `(module)` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/schools.ts:77 | `insertSchoolSettings` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:87 | `findSchoolById` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:104 | `updateIdentityConfig` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/schools.ts:167 | `mergeSettingsColumn` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/db/queries/schools.ts:171 | `mergeSettingsColumn` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/schools.ts:175 | `mergeSettingsColumn` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:210 | `findAcademicConfig` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:221 | `updateNotificationConfig` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:234 | `updateReportConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:300 | `resolveMinPartPayment` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:125 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:699 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1606 | `ensureSchoolSettings` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:179 | `fetchAcademicConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:48 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:50 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:52 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/termiiService.ts:32 | `getSmsSenderName` | pool (db/client.ts) |

## schools

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/platformRevenue.ts:82 | `getPlatformRevenue` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/schools.ts:52 | `insertSchool` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:87 | `findSchoolById` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:317 | `getSchoolPayoutConfig` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/schools.ts:327 | `updateSchoolPayoutConfig` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:334 | `getSchoolNameAndEmail` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/auth.ts:161 | `issueSession` | login client (routes/auth.ts getLoginClient) |
| SELECT | apps/api/src/routes/superAdmin.ts:528 | `GET /support-sessions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:584 | `GET /audit-logs` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:636 | `GET /schools` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:690 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:745 | `PATCH /schools/:schoolId/suspend` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:756 | `PATCH /schools/:schoolId/suspend` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:787 | `PATCH /schools/:schoolId/reactivate` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:813 | `PATCH /schools/:schoolId/reactivate` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:837 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:892 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:964 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:978 | `GET /subscriptions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1157 | `GET /pricing/preview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1249 | `GET /schools/:id/billing-preview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1304 | `POST /subscriptions` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1331 | `POST /subscriptions` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1416 | `PATCH /subscriptions/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1507 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1545 | `POST /subscriptions/:id/record-payment` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1630 | `GET /onboarding` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1658 | `POST /onboarding` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1666 | `POST /onboarding` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1711 | `GET /onboarding/:sessionId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1755 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1768 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1904 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:1971 | `principalEmail` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2048 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2049 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2051 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2059 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2064 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2107 | `GET /analytics/schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2172 | `GET /analytics/feature-adoption` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2215 | `GET /analytics/growth` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2477 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| SELECT | apps/api/src/services/planFeatures.ts:60 | `schoolAllowsFeature` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:39 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:40 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:51 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:54 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:56 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/welcomeEmail.ts:9 | `getSchoolName` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:54 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:153 | `getExistingScore` | pool (db/client.ts) |
| INSERT, UPDATE | apps/api/src/db/queries/scores.ts:172 | `upsertScore` | pool (db/client.ts) |
| INSERT, SELECT, UPDATE | apps/api/src/db/queries/scores.ts:270 | `bulkUpsertScores` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:409 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:461 | `getMyPendingAssignments` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:907 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:231 | `computeStudentSubjectResult` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:322 | `computeClassResults` | pool (db/client.ts) |

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
| SELECT ⚠ dynamic | apps/api/src/db/queries/schoolExport.ts:47 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:395 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:461 | `getMyPendingAssignments` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:246 | `registerStudent` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:363 | `getStudentProfile` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:509 | `findEnrollmentForSession` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/students.ts:521 | `insertStudentClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/students.ts:536 | `findEnrollmentForCurrentSession` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/students.ts:548 | `updateEnrollmentClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:164 | `getStudentClassIds` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:843 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:911 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:207 | `getStudentClassId` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:275 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:422 | `getStudentsAtRisk` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:29 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:34 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:395 | `getClassSheet` | pool (db/client.ts) |
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
| SELECT | apps/api/src/routes/students.ts:590 | `GET /:schoolId/students/:studentId` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:650 | `GET /schools` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:843 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:911 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:915 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/routes/superAdmin.ts:918 | `DELETE /schools/:schoolId/data` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1256 | `GET /schools/:id/billing-preview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2051 | `GET /analytics/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2221 | `GET /analytics/growth` | pool (db/client.ts) |
| SELECT | apps/api/src/services/platformAnalyticsService.ts:41 | `runPlatformAnalyticsSnapshot` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:275 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:422 | `getStudentsAtRisk` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:44 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:58 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:94 | `(module)` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:56 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:259 | `checkSubmittedResultsExist` | pool (db/client.ts) |
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
| SELECT | apps/api/src/db/queries/schoolExport.ts:45 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:372 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:461 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:75 | `findClassClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:97 | `findTeacherClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:113 | `getClassTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:128 | `getTeacherTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:285 | `computeClassResults` | pool (db/client.ts) |

## support_sessions

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/middleware/detectSupportSession.ts:67 | `detectSupportSession` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:414 | `POST /support-sessions` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:482 | `PATCH /support-sessions/:id/end` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:528 | `GET /support-sessions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2263 | `GET /health/overview` | pool (db/client.ts) |
| SELECT | apps/api/src/services/supportSessions.ts:16 | `terminateActiveSupportSessions` | pool (db/client.ts) |
| UPDATE | apps/api/src/services/supportSessions.ts:32 | `terminateActiveSupportSessions` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:49 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:39 | `checkTeacherAssigned` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:461 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/assignments.ts:152 | `POST /:schoolId/assignments` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/results.ts:116 | `POST /:schoolId/results/submit` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/teacherDashboard.ts:113 | `GET /:schoolId/dashboard/teacher/my-students` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:285 | `computeClassResults` | pool (db/client.ts) |

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
| SELECT | apps/api/src/db/queries/schoolExport.ts:30 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:43 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:86 | `findStudentsNotInClass` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:376 | `getClassSheet` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:461 | `getMyPendingAssignments` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:43 | `listSessionsWithTerms` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/sessions.ts:90 | `insertTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:102 | `listTermsBySession` | pool (db/client.ts) |
| UPDATE ⚠ dynamic | apps/api/src/db/queries/sessions.ts:138 | `updateTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:152 | `findTermById` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/sessions.ts:166 | `activateTerm` | pool (db/client.ts) |
| UPDATE | apps/api/src/db/queries/sessions.ts:171 | `activateTerm` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/sessions.ts:217 | `getCurrentContext` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/results.ts:266 | `GET /:schoolId/results/class-summary` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/roster.ts:504 | `POST /:schoolId/teacher-assignments/copy-from-term` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1809 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:207 | `getStudentClassId` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:271 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:275 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:422 | `getStudentsAtRisk` | pool (db/client.ts) |

## timetable_slots

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/db/queries/schoolExport.ts:68 | `(module)` | pool (db/client.ts) |
| INSERT | apps/api/src/db/queries/timetable.ts:59 | `insertSlot` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:75 | `findClassClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:97 | `findTeacherClash` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:113 | `getClassTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:128 | `getTeacherTimetable` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/timetable.ts:143 | `findSlotById` | pool (db/client.ts) |
| DELETE, SELECT | apps/api/src/db/queries/timetable.ts:152 | `deleteSlot` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2179 | `GET /analytics/feature-adoption` | pool (db/client.ts) |

## users

| Ops | Where | Function | Connection |
|---|---|---|---|
| SELECT | apps/api/src/config/systemActor.ts:6 | `(module)` | pool (db/client.ts) |
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
| SELECT | apps/api/src/db/queries/schoolExport.ts:34 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schoolExport.ts:37 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/schools.ts:65 | `schoolHasPrincipal` | pool (db/client.ts) |
| SELECT | apps/api/src/db/queries/scores.ts:395 | `getClassSheet` | pool (db/client.ts) |
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
| UPDATE | apps/api/src/db/queries/twoFactorStore.ts:119 | `activateTotp` | pool (db/client.ts) |
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
| UPDATE | apps/api/src/db/queries/users.ts:286 | `endSessionsBeforeNow` | pool (db/client.ts) |
| SELECT | apps/api/src/middleware/auth.ts:113 | `verifyToken` | pool (db/client.ts) |
| SELECT | apps/api/src/middleware/auth.ts:175 | `requirePasswordChanged` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/auth.ts:104 | `POST /create-user` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/auth.ts:132 | `POST /create-user` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/auth.ts:157 | `issueSession` | login client (routes/auth.ts getLoginClient) |
| SELECT ⚠ dynamic | apps/api/src/routes/auth.ts:239 | `POST /login` | login client (routes/auth.ts getLoginClient) |
| SELECT ⚠ dynamic | apps/api/src/routes/auth.ts:326 | `POST /login/verify` | login client (routes/auth.ts getLoginClient) |
| INSERT, UPDATE | apps/api/src/routes/auth.ts:468 | `POST /seed-test-user` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/students.ts:962 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/students.ts:994 | `POST /:schoolId/students/:studentId/parents` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:401 | `POST /support-sessions` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:528 | `GET /support-sessions` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:584 | `GET /audit-logs` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:706 | `GET /schools/:schoolId` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:843 | `GET /schools/:schoolId/export` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1092 | `GET /pricing` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1825 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:1844 | `PATCH /onboarding/:sessionId/step/:stepNumber` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:1913 | `POST /onboarding/:sessionId/complete` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2221 | `GET /analytics/growth` | pool (db/client.ts) |
| SELECT ⚠ dynamic | apps/api/src/routes/superAdmin.ts:2367 | `GET /announcements` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2477 | `POST /announcements/:id/publish` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2536 | `GET /admins` | pool (db/client.ts) |
| INSERT | apps/api/src/routes/superAdmin.ts:2608 | `POST /admins` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2656 | `POST /admins/:id/resend-welcome` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2688 | `countOtherActiveAdmins` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2709 | `PATCH /admins/:id/suspend` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2726 | `PATCH /admins/:id/suspend` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2764 | `PATCH /admins/:id/reactivate` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2778 | `PATCH /admins/:id/reactivate` | pool (db/client.ts) |
| SELECT | apps/api/src/routes/superAdmin.ts:2820 | `DELETE /admins/:id` | pool (db/client.ts) |
| UPDATE | apps/api/src/routes/superAdmin.ts:2850 | `DELETE /admins/:id` | pool (db/client.ts) |
| SELECT | apps/api/src/scripts/seedSuperAdmin.ts:19 | `main` | pool (db/client.ts) |
| INSERT | apps/api/src/scripts/seedSuperAdmin.ts:40 | `main` | pool (db/client.ts) |
| SELECT | apps/api/src/services/notificationWorker.ts:59 | `processRow` | pool (db/client.ts) |
| SELECT | apps/api/src/services/resultEngine.ts:275 | `computeClassResults` | pool (db/client.ts) |
| SELECT | apps/api/src/services/schoolExportArchive.ts:60 | `(module)` | pool (db/client.ts) |
| SELECT | apps/api/src/services/subscriptionService.ts:18 | `getSystemActorId` | pool (db/client.ts) |

## Tables no application code touches

