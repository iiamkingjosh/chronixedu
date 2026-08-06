# Plan-Based Feature Gating + Homepage Pricing Update — Design Spec

**Date:** 2026-08-06
**Status:** Approved for implementation planning

## Overview

Chronix Edu is moving from a 4-tier flat-monthly pricing model (`basic`/`professional`/`enterprise`/`trial`, marketed as Starter/Growth/Pro/Enterprise on the homepage) to a 2-tier per-student-per-term model: **Basic (₦400/student/term)** and **Premium (₦600/student/term)**, plus an **Enterprise** tier that is Premium's feature set under custom-negotiated pricing for boarding schools.

Today, `plan` is purely a billing label — every school gets every feature regardless of tier (confirmed by exhaustive search: the only places `plan` drives any behavior are trial-expiry suspension, which is status-based not tier-based, and announcement audience targeting). This spec adds real enforcement so Basic and Premium are functionally different, and updates the public pricing page to match.

**Explicitly out of scope:** automated per-student-per-term billing calculation/invoicing. `platform_subscriptions.amount_naira` stays a manually-entered number, exactly as it works today — this spec only adds the plan enum values and the feature checks tied to them.

## Current State (reference)

- **Plan enum**, duplicated across 5 zod schemas, no DB-level enum/CHECK — `platform_subscriptions.plan` is unconstrained `TEXT`:
  - `apps/api/src/routes/superAdmin.ts:66` — `listSchoolsQuerySchema`
  - `apps/api/src/routes/superAdmin.ts:89` — `createSubscriptionSchema`
  - `apps/api/src/routes/superAdmin.ts:106` — `updateSubscriptionSchema`
  - `apps/api/src/routes/superAdmin.ts:211` — `announcementPlanEnum`
  - `apps/api/src/routes/superAdmin.ts:907` — `PLANS` const for MRR aggregation (excludes `trial`)
  - Frontend: `apps/web/lib/superAdminApi.ts:10` — `export type SchoolPlan = 'basic' | 'professional' | 'enterprise' | 'trial';`
- **Zero real schools exist in production today** (verified directly against the DB — the only 4 rows are leftover test fixtures from earlier feature work, none with a `platform_subscriptions` row). The enum can be renamed freely with no migration/backfill concern.
- **`schools.subscription_tier`** (`migrations/001_create_chronix_edu_schema.sql:44`, nullable `TEXT`) is set once at onboarding start to `'trial'` (`superAdmin.ts:1238-1239`) and **never updated again** — confirmed no `UPDATE schools SET subscription_tier` exists anywhere. It is not currently selected by `findSchoolById` (`apps/api/src/db/queries/schools.ts`), so it isn't available on `res.locals.school`.
- **`requireActiveSchool`** (`apps/api/src/middleware/requireActiveSchool.ts`) is mounted app-wide at `app.use('/api/schools', requireActiveSchool)` (`apps/api/src/index.ts:130`). It loads the school once per request via `cache.wrap(schoolCacheKey(schoolId, 'data'), cache.TTL.SCHOOL, () => findSchoolById(schoolId))` and stores it on `res.locals.school`. Super admins bypass it entirely.
- **SMS is sent from two different kinds of call sites**, which matters for where gating logic lives:
  - Route-triggered (synchronous, within a request): attendance auto-alerts, fired from inside the `POST /:schoolId/attendance/mark` handler.
  - Cron-triggered (no request at all): `apps/api/src/services/feeReminderService.ts` — `registerCron('weekly-fee-reminders', '0 8 * * 1', ...)` calls `sendFeeRemindersForSchool(schoolId, termId)` for every school with outstanding balances, every Monday at 8am, with no HTTP request in the loop.
- **Paystack fee collection**: bursar payout setup (`apps/api/src/routes/schools.ts`, `GET/POST/PUT .../settings/payout`) and the parent-facing initiate route (`apps/api/src/routes/fees.ts`, `POST /:schoolId/payments/paystack/initiate`).
- **Analytics**: `apps/api/src/routes/analytics.ts`, `GET /:schoolId/analytics/overview`, principal/super_admin only.
- **"Bulk export" does not exist as a school-facing feature.** The only CSV export found (`superAdmin.ts:693-730`) is a super-admin-only tool for downloading a school's enrolled students; report cards are generated one student at a time, not in bulk. Not part of this spec's gated-feature list.
- **Homepage pricing** (`apps/web/app/home-page.tsx:499-570`) — 4-card grid (Starter ₦15k/Growth ₦35k/Pro ₦65k/Enterprise Custom), monthly/annual toggle, each card `mailto:` CTA.

## Decisions Made

- **Scope**: feature-gating + homepage update only. No billing/invoicing automation.
- **Plan enum simplifies to**: `trial` | `basic` | `premium` | `enterprise` (drops `professional`, renames the paid tiers).
- **`enterprise`** = identical feature access to `premium`, exists only as a pricing/label distinction for individually-negotiated boarding-school deals. No boarding-specific features (dormitory, meal plans, etc.) are built as part of this spec — that would be a separate, larger project.
- **`trial`** gets full Premium-equivalent feature access (to showcase the product and drive conversion).
- **Gated (Premium/trial/enterprise only, blocked on Basic)**:
  - SMS sending (attendance alerts, fee reminders)
  - Online Paystack fee collection (both bursar payout setup and parent-facing payment)
  - Analytics dashboard (`GET /:schoolId/analytics/overview`)
- **Not gated (every tier, including Basic)**: results, report cards, attendance tracking, behaviour records, timetable, parent/student portals, in-app messaging/announcements, fee invoice creation, and manual (cash/bank-transfer) payment recording.
- **Enforcement mechanism**: denormalize plan onto `schools.subscription_tier`, kept in sync by `platform_subscriptions` writes, added to `findSchoolById`'s existing SELECT so it rides along on the same cached row `requireActiveSchool` already loads on every school-scoped request — no new query on the hot path.

## Behavior

### 1. Backend — plan enum simplification

Replace all 5 duplicated zod enum definitions and the frontend `SchoolPlan` type with `['trial', 'basic', 'premium', 'enterprise']`. Update `apps/web/app/super-admin/schools/[id]/page.tsx` (subscription edit form) and `apps/web/app/super-admin/announcements/page.tsx` (`ALL_PLANS`) accordingly. No data migration needed (zero real schools exist).

### 2. Backend — sync `schools.subscription_tier`

In `apps/api/src/routes/superAdmin.ts`:
- `POST /subscriptions` (currently ~L932-974): after inserting the `platform_subscriptions` row, also `UPDATE schools SET subscription_tier = $1 WHERE id = $2` with the same `plan` value.
- `PATCH /subscriptions/:id` (currently ~L979-1024): whenever the dynamic field-list update includes a `plan` change, apply the same `UPDATE schools SET subscription_tier = ...` after the `platform_subscriptions` update succeeds.

Add `subscription_tier` to `findSchoolById`'s SELECT list (`apps/api/src/db/queries/schools.ts`) and to the `SchoolWithSettings`/`SchoolRow` interface, so it's present on `res.locals.school` for every request through the existing `requireActiveSchool` middleware.

### 3. Backend — shared feature-check helper (not middleware-only)

New small module, e.g. `apps/api/src/services/planFeatures.ts`:

```ts
export type PlanFeature = 'sms' | 'online_payments' | 'analytics';

// All three PlanFeature values are Premium+-only today (Basic gets none of
// them) — planIncludesFeature takes a feature argument now so this can grow
// into a real per-feature table later without changing any call site.
export function planIncludesFeature(subscriptionTier: string | null | undefined, _feature: PlanFeature): boolean {
  if (subscriptionTier === 'basic') return false;
  // trial, premium, enterprise, and any unrecognized/null value all pass —
  // fail open toward access rather than silently locking out a
  // just-onboarded school with a not-yet-assigned plan.
  return true;
}
```

Two consumers of this same function:
- **Route middleware** `requireFeature(feature: PlanFeature)` in a shared middleware file, used the same way `requireActiveSchool`/`requireRole` are composed today: checks `res.locals.school?.subscription_tier` (already loaded), returns `403 { code: 'FEATURE_NOT_IN_PLAN', message: "This feature isn't available on your school's current plan" }` if `planIncludesFeature` is false. Applied to: the payout settings routes and `payments/paystack/initiate` in `fees.ts`, and `GET /:schoolId/analytics/overview`.
- **Direct call inside `feeReminderService.ts`**: `sendFeeRemindersForSchool` fetches the school's `subscription_tier` (a small dedicated query, since the cron has no `res.locals.school` to reuse) and skips the SMS send (continues sending in-app + email reminders) for Basic-tier schools, logging a debug line so this is visible in cron output rather than silently dropped.
- **Attendance auto-alert route**: the same `planIncludesFeature` check gates the SMS leg specifically (in-app/email alerts still fire for Basic), reusing `res.locals.school` already present via `requireActiveSchool`.

### 4. Frontend — hide gated UI by plan

`useAuth()`'s school/user context already exposes enough to add a `subscriptionTier` field (sourced from the same `schools.subscription_tier` now returned by relevant endpoints). The payout settings nav entry, the parent "Pay Now" button, and the analytics dashboard nav link are hidden (not just disabled) for Basic-tier schools, following the existing pattern where `settings/payout/page.tsx` already gates its own nav visibility by role — this extends the same technique to plan.

### 5. Homepage — pricing section rewrite

`apps/web/app/home-page.tsx`, the `#pricing` section (currently L499-570): replace the 4-card monthly/annual-toggle grid with two cards side by side:
- **Basic** — ₦400/student/term — "Results, attendance, timetable, portals, and fee tracking — everything a school needs to run day to day." Feature bullets: results & report cards; attendance & behaviour tracking; timetable; parent & student portals; fee invoicing & manual payment recording; in-app messaging.
- **Premium** — ₦600/student/term (badge "Recommended") — "Everything in Basic, plus SMS alerts and online fee collection." Feature bullets: everything in Basic; SMS reminders for attendance & fees; online payment collection via Paystack (settles directly to your school's bank account); analytics dashboard.

Below the two cards, a smaller **Enterprise** callout: "Boarding schools & multi-campus groups — custom pricing." CTA "Talk to Sales" → same `mailto:edu@chronixtechnology.com` pattern already used. Drop the monthly/annual toggle entirely (per-term billing has no monthly/annual distinction); drop the student-count caps per card (per-student pricing has no cap to state).

## Error Handling

- **Basic-tier school hits a gated route directly** (e.g., via API, bypassing hidden UI): `403 FEATURE_NOT_IN_PLAN` with a message pointing at what's gated, not a generic 403.
- **`schools.subscription_tier` is `null`** (shouldn't happen post-onboarding, since onboarding always sets `'trial'`, but defensively): treated as feature-inclusive (fails open), per `planIncludesFeature`'s explicit comment — never silently locks out a school due to a missing/unexpected value.
- **Cron SMS skip for Basic**: `sendFeeRemindersForSchool` continues sending in-app + email reminders regardless of tier; only the SMS leg is skipped, with a logged line (not a thrown error — this is an expected, routine skip, not a failure).

## Testing

- Unit: `planIncludesFeature()` — true for premium/trial/enterprise/null/unrecognized values, false only for `'basic'`, for each of the 3 `PlanFeature` values.
- Route tests: `requireFeature('online_payments')` on the Paystack initiate route — 403 for a Basic-tier school, 200 (proceeds) for Premium/trial. Same pattern for the analytics route and payout settings routes.
- `feeReminderService` test: Basic-tier school's outstanding-balance parents receive in-app + email notifications but `sendTermiiSms` is not called; Premium-tier school gets all three channels — extending the existing `notificationPipeline.test.ts`-style fixture pattern.
- `POST /subscriptions` and `PATCH /subscriptions/:id` tests: assert `schools.subscription_tier` is updated to match `plan` after each call.
- No test needed for the homepage pricing section (marketing content, no existing test coverage pattern for this page in the codebase).

## Out of Scope

- Automated per-student-per-term billing/invoicing calculation — `amount_naira` stays manually entered.
- Boarding-school-specific features (dormitory/hostel management, meal plans, etc.) — `enterprise` is a pricing label only in this spec.
- A DB-level enum/CHECK constraint on `platform_subscriptions.plan` or `schools.subscription_tier` (still validated only at the Zod layer, matching current practice) — could be a future hardening pass, not needed for this feature to work correctly.
- Removing/backfilling `schools.subscription_tier` for any pre-existing schools — moot, since none exist.
