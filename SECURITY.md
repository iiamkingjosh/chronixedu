# Security Audit — Chronix Edu

**Latest audit:** Round 5 — 2026-07-09  
**Scope:** API routes, authentication middleware, CSP headers, rate limiting, Paystack webhook, impersonation system, support session handling, attendance/score/student access, fees, announcements, PWA caching, platform analytics  
**Round 5 total findings:** 19 (2 Critical · 8 High · 9 Medium · 6 Low · 4 Info)

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

### I-02 — Lockout per-email only ⚠️ Accepted risk / 🔜 Post-launch

**File:** `apps/api/src/routes/auth.ts`  
**Status:** Documented. A `TODO` comment tracks the planned per-IP lockout enhancement to block distributed brute-force across many email accounts from the same IP address.

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
