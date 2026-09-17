# Security Audit — Chronix Edu

**Latest audit:** Round 9 — 2026-09-17  
**Scope:** Academic-records write authorization (scores/results)  
**Round 9 total findings:** 1 (0 Critical · 1 High · 0 Medium · 0 Low · 0 Info)

---

## Round 9 — 2026-09-17

**Scope:** Audit of the scores/results subsystem — could a teacher tamper with grades outside their own assignment, or could the assessment-config model itself corrupt scores across subjects.

### H-01 — Teacher could write scores for any student in the school, or silently overwrite another subject's score ✅ Fixed

**Files:** `apps/api/src/routes/scores.ts`, `apps/api/src/db/queries/scores.ts`, `migrations/028_widen_scores_unique_constraint.sql`  
**Fix:** Two compounding bugs. First, a teacher legitimately assigned to `(subject, class, term)` could submit any `student_id` in the school — `class_id` was checked against the teacher's own assignment but never cross-checked against the submitted student's actual enrollment, and `class_id` isn't even stored on the `scores` row, so a forged write was indistinguishable from a legitimate one. Second, the `scores` table's unique key omitted `subject_id`; when a school uses a shared/default assessment config (the web UI's own default setup), different subjects resolve to the same `component_id`, so one subject's score silently overwrote another's, misattributed under whichever subject wrote last. Fixed by validating the submitted student is actually enrolled in the class before writing, resolving the component against the assessment config for the specific class/subject/term rather than "any component in the school," and widening the unique constraint to `(student_id, subject_id, term_id, component_id)`.

---

## Round 8 — 2026-09-01

**Scope:** Forced-password-change enforcement after the bulk-import shared-temp-password model was flagged as a risk; a follow-up audit of the finance/payments subsystem (fee invoices, Paystack online payments, payout settings).

### H-01 — Shared bulk-import temp password had no server-side enforcement to change it ✅ Fixed

**Files:** `apps/api/src/middleware/auth.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/auth.ts`  
**Fix:** Added `requirePasswordChanged` middleware, mounted on `/api/schools/*` right after `verifyToken`. An account with `must_change_password` still `TRUE` (e.g. a freshly bulk-imported staff/student using the shared temp password) can now only reach `POST /api/auth/change-password` — every other route returns `403 PASSWORD_CHANGE_REQUIRED`. This closes the real risk in a shared/predictable temp password: whoever authenticates with it first — the legitimate recipient or an attacker who reached it first — gets a session that can do nothing except set a new password. Checks live DB state (Redis-cached, same pattern as the existing `is_active` check), with cache invalidation wired into both `/change-password` and `/confirm-reset` so a session unblocks on its very next request.

### H-02 — Paystack payment double-delivery could surface as a false failure or lose a real payment entirely ✅ Fixed

**Files:** `apps/api/src/db/queries/fees.ts`, `apps/api/src/routes/feesPublic.ts`  
**Fix:** Every online payment is delivered twice (Paystack's webhook + the browser callback), and the parent portal always charges the full remaining balance. `recordPayment()` checked "does this overpay the invoice?" before checking "have I already recorded this exact transaction?", so the loser of that race saw balance = 0 and threw an overpayment error instead of being recognized as a duplicate — surfacing as an uncaught 500 to the payer, or (for a second guardian paying the same invoice) as real money settling to the school's account with no `payments` row, no receipt, and no audit entry at all. Fixed by checking `paystack_reference` for an existing row before the overpayment guard, and by no longer rejecting a verified Paystack payment for exceeding the balance — that money is already captured and settled, so it's recorded in full (as a credit) rather than silently lost. Staff-entered cash/bank_transfer/waiver amounts are unaffected and still rejected on overpayment, since no money has moved yet there.

### M-01 — Payout-settings step-up re-authentication had no brute-force lockout ✅ Fixed

**File:** `apps/api/src/routes/schools.ts`  
**Fix:** The password check when changing a school's payout bank account called Supabase auth directly, skipping the Redis-backed lockout counter the login route already uses — an unlimited password-guessing oracle for whoever could reach the route. Added the same lockout (5 attempts/email, 20/IP, 15-minute window) used by `POST /api/auth/login`.

### L-01 — `paystack_reference` accepted on non-Paystack manual payments ✅ Fixed

**File:** `apps/api/src/routes/fees.ts`  
**Fix:** `paymentSchema` only validated the forward direction (Paystack method requires a reference) but never the reverse, so a bursar/super_admin could submit `{method: 'cash', paystack_reference: '<any string>'}` and it would be written to the globally-unique `paystack_reference` column — a colliding value could in principle swallow a real online payment recorded later under the same reference (mitigated in practice by references being server-generated UUIDs, but tightened as defense in depth). Closed with a second `.refine()` rejecting `paystack_reference` whenever `method !== 'paystack'`.

---

## Round 7 — 2026-08-06/07

**Scope:** Full white/black/gray-hat review across auth, injection, payments, and data exposure; a same-week follow-up closed a privilege-escalation bug the first fix in the pair had (unintentionally) widened.

### H-01 — Paystack webhook/callback mounted behind the global auth chain — no online payment could ever reconcile ✅ Fixed

**Files:** `apps/api/src/index.ts`, `apps/api/src/routes/fees.ts`, `apps/api/src/routes/feesPublic.ts`  
**Fix:** Both endpoints returned `401` before their handlers ever ran, since Paystack cannot supply a bearer token for either a server-to-server webhook or an unauthenticated browser redirect. Moved both onto a new public router (`feesPublic.ts`) mounted ahead of the auth chain. Also added the same school/invoice metadata binding the webhook already had to the manual payment-recording route, closing a cross-tenant payment mismatch where a reference from one school could be recorded against another school's invoice.

### H-02 — Bursar could redirect a school's entire fee settlement to any bank account ✅ Fixed

**Files:** `apps/api/src/routes/schools.ts`, `apps/web/app/(dashboard)/settings/payout/page.tsx`  
**Fix:** No confirmation beyond "is this bursar at this school" gated a payout-destination change. Restricted the write to `principal`/`super_admin` and added a password re-confirmation step-up, with a matching UI update on the payout settings page. (The step-up itself later needed its own lockout fix — see Round 8 M-01.)

### M-01 — Three GET routes missing the role check present on every sibling route ✅ Fixed

**File:** `apps/api/src/routes/attendance.ts`  
**Fix:** Any authenticated school member, including students, could read any class's full roster and attendance history. Added the missing `requireRole` gate to match the rest of the module.

### M-02 — Report cards, transcripts, and receipts stored as permanent unauthenticated public URLs ✅ Fixed

**Files:** `apps/api/src/services/reportCardService.ts`, `apps/api/src/services/receiptService.ts`, `apps/api/src/services/transcriptService.ts`, `apps/api/src/routes/assignments.ts`, `apps/api/src/db/queries/reportCards.ts`  
**Fix:** Switched from permanent public Supabase Storage URLs to short-lived signed URLs minted per-request, after the existing role/ownership checks, across report cards, transcripts, receipts, and assignment submissions.

### M-03 — CSV/formula injection in exports ✅ Fixed

**Files:** `apps/web/lib/csv.ts`, `apps/web/app/(dashboard)/principal/attendance/page.tsx`, `apps/web/app/(dashboard)/bursar/outstanding/page.tsx`, `apps/api/src/routes/superAdmin.ts`  
**Fix:** No escaping at all on the principal attendance export or the super-admin student export, allowing formula injection in spreadsheet applications. Added cell-value escaping in the shared CSV helper.

### M-04 — Revoked platform admins kept access for up to 5 minutes after suspend/delete ✅ Fixed

**File:** `apps/api/src/routes/superAdmin.ts`  
**Fix:** The session cache was never busted on admin suspend/delete, and their active impersonation sessions were never terminated. Both are now cleared immediately on the same write.

### L-01 — `report_cards.is_published` was never set to `TRUE` anywhere, so the parent/student report-card route always 404'd ✅ Fixed

**Files:** `apps/api/src/routes/results.ts`, `apps/api/src/services/reportCardService.ts`, `apps/api/src/db/queries/reportCards.ts`, `apps/api/src/routes/students.ts`  
**Fix:** The results-publish workflow now actually sets `is_published`. The one path that had ever worked was a staff endpoint that incorrectly allowed the `parent` role with no publish filter — gated to match.

### L-02 — Teachers could mark attendance for classes they weren't assigned to ✅ Fixed

**File:** `apps/api/src/routes/attendance.ts`  
**Fix:** Added a teacher-assignment check to the attendance-marking route, matching the pattern used elsewhere (e.g. score entry).

### L-03 — Manual payment-recording route didn't bind the Paystack reference to the target school/invoice ✅ Fixed

**File:** `apps/api/src/routes/fees.ts`  
**Fix:** The webhook and callback already verified this; the manual route now does too.

### H-03 — Unauthenticated seed-test-user route could create a super_admin account when misconfigured ✅ Fixed

**Files:** `apps/api/src/routes/auth.ts`, `apps/api/src/__tests__/authSeedTestUserSecurity.test.ts`  
**Fix:** An earlier same-week fix (broadening the route's guard from `NODE_ENV === 'development'` to `NODE_ENV !== 'production'`, to stop the route 404ing under Jest) widened the set of environments where the route registers to include any unconfigured `NODE_ENV` — plausible on Railway, which doesn't auto-inject `NODE_ENV=production` — and exposed a pre-existing fail-open bug: `req.headers['x-seed-secret'] !== process.env.SEED_SECRET` passes when both sides are `undefined`, since `SEED_SECRET` was never in the required env schema. Together: a non-production deploy with `NODE_ENV` unset and `SEED_SECRET` never configured would let an unauthenticated request create a user with an arbitrary client-supplied role, including `super_admin`. Fixed by only registering the route when `SEED_SECRET` is actually set, in addition to the `NODE_ENV` check — a missing secret now closes the route entirely rather than falling through to an always-true comparison. Verified with a new test that reproduces the exact scenario against the pre-fix code before confirming the fix closes it.

---

## Round 6 — High

### H-01 — Principal can create `super_admin` users via school users endpoint ✅ Fixed

**File:** `apps/api/src/routes/users.ts`  
**Fix:** Removed `'super_admin'` from `CREATABLE_ROLES` (the enum used by `createUserSchema`). A pre-parse runtime guard returns `403 FORBIDDEN` if `req.body.role === 'super_admin'` before Zod even runs. Creating platform admins must go through `POST /auth/create-user`, which enforces `ROOT_ADMIN_EMAIL` ownership.

---

## Round 6 — Medium

### M-01 — Sensitive admin recovery script with hardcoded production email committed ✅ Fixed

**File:** `apps/api/src/scripts/repairAuthUser.ts`  
**Fix:** Deleted the script and added `apps/api/src/scripts/repairAuthUser.ts` to `.gitignore`. The script had a hardcoded root admin email and reset super_admin credentials — unsuitable for source control.

### M-02 — Login catch block returns raw `err.message` to clients in production ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** Replaced the manual `res.status(500).json({ message: err.message })` with `return next(err)`. All errors now flow through the global `errorHandler`, which sanitises messages to `'An unexpected error occurred'` in production. Also added `next: NextFunction` to the login handler signature.

---

## Round 6 — Low

### L-01 — Paystack webhook records payment amount from webhook body instead of re-verifying via API ✅ Fixed

**File:** `apps/api/src/routes/fees.ts`  
**Fix:** After HMAC signature verification, the webhook handler now calls `verifyPaystackTransaction(data.reference)` and uses `verification.amount`. This matches the behaviour of `POST /payments`. Webhook events with missing references or non-`success` verification status are acknowledged (200) but not recorded.

### L-02 — Misleading "fail open" comment in `verifyToken` ✅ Fixed

**File:** `apps/api/src/middleware/auth.ts`  
**Fix:** Updated comment to accurately describe the fail-closed (503) behaviour instead of the old fail-open design that was removed in Round 5.

---

## Round 6 — Info

### I-01 — Rate limiter MemoryStore fallback is per-process ⚠️ Accepted risk

**File:** `apps/api/src/middleware/rateLimit.ts`  
**Status:** Documented with a comment. In a multi-replica deployment each instance has independent MemoryStore counters. The per-email Redis lockout in the login route (`MAX_ATTEMPTS = 5`) is the stronger control and is Redis-backed. No change required for Railway single-replica deployment; ensure `REDIS_URL` is set if horizontal scaling is enabled.

---

---

## Status key

| Symbol | Meaning |
|--------|---------|
| ✅ Fixed | Patched and deployed |
| ⚠️ Accepted risk | Known, documented, consciously accepted |
| 🔜 Post-launch | Planned for a future release |

---

## Round 5 — Critical

### C-01 — Support session token bypasses audit trail ✅ Fixed

**Files:** `apps/api/src/routes/superAdmin.ts`, `apps/api/src/middleware/detectSupportSession.ts`, `apps/api/src/middleware/auth.ts`  
**Fix:** Scoped JWT now includes `is_support_session: true` and `real_admin_id`. `detectSupportSession` checks a Redis blacklist so revoked tokens are immediately rejected. `verifyToken` rejects support-session JWTs that arrive without the matching `X-Support-Session-ID` header. Support session token stored in Redis (`support_session_token:{sessionId}`) and moved to `blacklisted_token:{token}` on session end.

### C-02 — Error handler returns raw DB exception messages ✅ Fixed

**File:** `apps/api/src/middleware/errorHandler.ts`  
**Fix:** In production (`NODE_ENV !== 'development'`) the error handler returns the generic message `'An unexpected error occurred'`. Stack traces and raw exception messages are only included in development responses.

---

## Round 5 — High

### H-01 — Report card endpoint missing role restriction ✅ Fixed

**File:** `apps/api/src/routes/students.ts`  
**Fix:** `GET /students/:studentId/report-card` now requires `requireSchoolAccess` + `requireRole('super_admin', 'principal', 'teacher', 'parent', 'student')`. Parent callers must pass a school-scoped parent-student link check; student callers must match their own record.

### H-02 — Class score sheet missing role restriction ✅ Fixed

**File:** `apps/api/src/routes/scores.ts`  
**Fix:** `GET /scores/class-sheet` now requires `requireRole('super_admin', 'principal', 'teacher')`. Teachers are additionally restricted to classes they are assigned to for the requested term.

### H-03 — Student list and detail missing role restriction ✅ Fixed

**File:** `apps/api/src/routes/students.ts`  
**Fix:** `GET /students` restricted to `super_admin`, `principal`, `registrar`, `teacher`. `GET /students/:studentId` checks role and enforces parent-child ownership for parent callers and self-only for student callers.

### H-04 — Student photo upload trusts client Content-Type ✅ Fixed

**File:** `apps/api/src/routes/students.ts`  
**Fix:** Magic-byte detection via `file-type` (`fromBuffer`) replaces the `mimetype` field from the multipart form. The detected MIME type is used for the Supabase Storage upload.

### H-05 — Plaintext temp passwords in onboarding_sessions ✅ Fixed

**File:** `apps/api/src/routes/superAdmin.ts`  
**Fix:** Step 6 stores `'[cleared after email sent]'` as the `temp_password` value in `steps_completed`. The `/complete` handler detects this placeholder and sends a generic message in the welcome email instead of re-emitting the password.

### H-06 — Parent email lookup missing school scope ✅ Fixed

**File:** `apps/api/src/routes/students.ts`  
**Fix:** Parent email uniqueness check now queries `WHERE email = $1 AND school_id = $2`, preventing cross-school email enumeration.

### H-07 — rootGuard not applied to POST /admins ✅ Fixed

**File:** `apps/api/src/routes/superAdmin.ts`  
**Fix:** `POST /admins` now uses `...rootGuard` (verifyToken + requireRole + requireRootAdmin) instead of the plain `...guard`, so only the root platform admin email can create new super_admin accounts.

### H-08 — PG client connection leak in auth routes ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** All `getPgClient()` usages in `create-user` and `login` are now wrapped in `try { ... } finally { await pg.end(); }`, guaranteeing connection release on every code path including early returns and thrown exceptions.

---

## Round 5 — Medium

### M-01 — Login response discloses remaining attempt count ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** Login 401 responses always return `{ code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password' }` regardless of attempt count. The attempt counter continues to increment internally; only the lockout message is surfaced to the caller.

### M-02 — confirm-reset leaks user existence via 404 ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** When the local user record is not found after a valid Supabase token, the response is now `401 INVALID_OR_EXPIRED_TOKEN` with the same message as an expired token, preventing user enumeration.

### M-03 — Student attendance endpoint missing role restriction ✅ Fixed

**File:** `apps/api/src/routes/attendance.ts`  
**Fix:** `GET /:schoolId/attendance/student/:studentId` now enforces role-based access: staff (super_admin/principal/teacher) can view any student; parents must pass a `isParentLinkedToStudent` check; students may only view their own record. Unauthenticated roles receive 403.

### M-04 — Class attendance endpoint missing role restriction ✅ Fixed

**File:** `apps/api/src/routes/attendance.ts`  
**Fix:** `GET /:schoolId/attendance/class` now requires `requireRole('super_admin', 'principal', 'teacher')` in addition to school access.

### M-05 — Double payment for cash/bank transfer ✅ Fixed

**Files:** `apps/api/src/db/queries/fees.ts`, `apps/api/src/routes/fees.ts`  
**Fix:** `recordPayment()` checks for an existing payment with the same `invoice_id`, `method`, and `amount` within the last 5 minutes (inside the same transaction). On duplicate detection, the transaction is rolled back and `DuplicatePaymentError` is thrown. The route handler catches it and returns `409 DUPLICATE_PAYMENT`.

### M-06 — Suspended users bypass suspension during Redis/DB outage ✅ Fixed

**File:** `apps/api/src/middleware/auth.ts`  
**Fix:** The Step 2 try/catch in `verifyToken` is now fail-closed. Any Redis or DB error during the suspension check returns `503 SERVICE_UNAVAILABLE` with a `logger.error` entry instead of silently passing the request through.

### M-07 — Dynamic SQL column names from Zod fields ✅ Fixed

**File:** `apps/api/src/routes/superAdmin.ts`  
**Fix:** `PATCH /subscriptions/:id` and `PATCH /announcements/:id` now iterate over explicit `as const` allowlist arrays (`SUBSCRIPTION_FIELDS`, `ANNOUNCEMENT_FIELDS`) instead of `Object.entries(parsed.data)`. Only fields in the allowlist can appear in the UPDATE statement.

### M-08 — Log file reader uses arbitrary env-var path ✅ Fixed

**File:** `apps/api/src/services/platformAnalyticsService.ts`  
**Fix:** `getRecentErrorCount()` now reads from a hardcoded `path.join(process.cwd(), 'logs', 'combined.log')` instead of `process.env.LOG_FILE_PATH`, removing the ability to point the reader at arbitrary filesystem paths via configuration.

### M-09 — Announcement body sent unsanitized to email ✅ Fixed

**Files:** `apps/api/src/routes/superAdmin.ts`, `apps/api/src/routes/announcements.ts`  
**Fix:** `sanitize-html` (with `allowedTags: [], allowedAttributes: {}`) strips all HTML from announcement bodies before they are passed to `sendEmail`, preventing HTML injection in email clients that render rich content.

---

## Round 5 — Low

### L-01 — Debug logs emit user IDs ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** Removed `logger.debug('login_auth_result', ...)` and `logger.debug('login_local_user_lookup', ...)` from the login flow. User IDs are no longer written to the log stream.

### L-02 — PWA caches authenticated API responses ✅ Fixed

**File:** `apps/web/next.config.js`  
**Fix:** Added a `NetworkOnly` Workbox runtime caching rule for `/api/` URLs before the catch-all rule, ensuring API responses (which carry authentication state) are never served from the service-worker cache.

### L-03 — Health endpoint unauthenticated ✅ Fixed

**File:** `apps/api/src/index.ts`  
**Fix:** When `HEALTH_CHECK_TOKEN` is set in the environment, `/health` requires the value in the `X-Health-Token` header. Requests without a valid token receive `401 UNAUTHORIZED`. The endpoint remains open when the env var is unset (for local development).

### L-04 — Cross-tenant guard breaks platform super_admin user creation ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** The cross-tenant guard in `POST /create-user` now only fires when `req.user!.school_id != null`, allowing platform super_admins (whose `school_id` is `null`) to create users in any school while still blocking school-scoped admins from acting across tenant boundaries.

### L-05 — SELECT * in school detail endpoint ✅ Fixed

**File:** `apps/api/src/routes/superAdmin.ts`  
**Fix:** `GET /schools/:schoolId` now selects an explicit column list (`id, name, slug, email, address, phone, is_active, subscription_tier, legal_terms_accepted_at, created_at`) instead of `SELECT *`, preventing accidental exposure of future schema additions.

### L-06 — Rate limiter fires before school access check ✅ Fixed

**File:** `apps/api/src/routes/announcements.ts`  
**Fix:** Middleware order for `POST /:schoolId/announcements` changed to: `verifyToken → requireSchoolAccess → announcementLimiter → requireRole(...)`. The rate limiter now only counts requests from users who have already been authenticated and verified to belong to the school.

---

## Round 5 — Info

### I-01 — No JWT refresh token ⚠️ Accepted risk / 🔜 Post-launch

**File:** `apps/web/lib/api.ts`  
**Status:** Documented. A `TODO` comment in `api.ts` tracks the planned post-launch implementation of JWT refresh tokens alongside the cookie-based auth migration.

### I-02 — Lockout per-email only ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** Login now tracks two independent Redis counters: `login_attempts:{email}` (threshold 5) and `login_attempts_ip:{ip}` (threshold 20). Either counter reaching its limit triggers a 429. The higher IP threshold avoids false positives from shared corporate NAT. Both counters are cleared on successful login.

### I-03 — Missing Permissions-Policy and Referrer-Policy headers ✅ Fixed

**File:** `apps/web/next.config.js`  
**Fix:** Added `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()` and `Referrer-Policy: strict-origin-when-cross-origin` to the `headers()` function, applied to all routes.

### I-04 — SENDGRID_FROM_EMAIL hardcoded fallback ✅ Fixed

**Files:** `apps/api/src/index.ts`, `apps/api/.env.example`  
**Fix:** Added a startup guard in `index.ts`: if `SENDGRID_API_KEY` is set but `SENDGRID_FROM_EMAIL` is not, the server refuses to start with a fatal error. `SENDGRID_FROM_EMAIL` is documented in `.env.example`.

---

## Prior rounds (summary)

### Round 4

| ID | Finding | Status |
|----|---------|--------|
| H-01 | JWT empty-string signing when JWT_SECRET unset | ✅ Fixed |
| H-02 | CSP allows unsafe-inline and unsafe-eval | ✅ Fixed |
| H-03 | In-memory rate limiter resets on restart | ✅ Fixed |
| H-04 | Paystack webhook falls back to re-serialized body | ✅ Fixed |
| M-01 | CORS passes all no-Origin requests | ⚠️ Accepted risk |
| M-02 | trust proxy 1 IP spoofing | ⚠️ Accepted risk |
| M-03 | Impersonation actions logged under victim's ID | ✅ Fixed |
| M-04 | JWTs stored in localStorage | ⚠️ Accepted risk |
| L-01 | bcrypt cost factor 10 | ✅ Fixed |
| L-02 | Plaintext temp passwords in API response body | ✅ Fixed |

---

## Reporting a vulnerability

If you discover a security issue in Chronix Edu, please email **joshua4moses@gmail.com** with a description and reproduction steps. Do not open a public GitHub issue for security findings.
