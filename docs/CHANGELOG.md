# Chronix Edu — Changelog

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
