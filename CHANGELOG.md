# Changelog

## [Phase 4] — 2026-06-15

### Super Admin Platform — Complete

**New API surface** (`/api/super-admin/*`, `super_admin` role only):
- School management: list, detail, suspend, reactivate, CSV export,
  data wipe
- Subscription & billing: CRUD, MRR dashboard, trial extension,
  manual payment recording
- Onboarding wizard: 7-step school setup flow with per-step
  validation
- Platform analytics: overview KPIs, per-school activity scores,
  feature adoption, growth trends
- Platform health: cron status, active sessions, error monitoring
- Announcements: compose, schedule, publish with SendGrid delivery
- Impersonation: scoped session tokens, detectSupportSession
  middleware, full audit trail

**New middleware:**
- `detectSupportSession` — swaps req.user context for support
  sessions on school-scoped routes
- `requireSuperAdmin` — dedicated super_admin guard

**New services:**
- `subscriptionService` — trial expiry cron (9am daily)
- `platformAnalyticsService` — metrics snapshot cron (3am daily)
- `cronTracker` — in-memory cron health registry

**New tables (migrations 016–019):**
- `support_sessions`
- `platform_audit_logs`
- `platform_subscriptions`
- `onboarding_sessions`
- `platform_announcements`
- `platform_metrics_snapshots`

**Security hardening (pre-Phase 4):**
- JWT architecture confirmed: custom JWT_SECRET tokens throughout
- RLS verified: `auth.jwt() ->> 'school_id'` (no app_metadata)
- Suspend/reactivate now requires `reason` field (audit trail)
- Jest config fixed: ts-jest replacing babel-jest

**Test coverage:**
- superAdmin.test.ts: 54 tests
- phase4Integration.test.ts: 5 suites
- resultEngine.test.ts: fixed stale assertions
