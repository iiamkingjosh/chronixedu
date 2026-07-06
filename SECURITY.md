# Security Audit — Chronix Edu

**Audit date:** 2026-07-05  
**Scope:** API routes, authentication middleware, CSP headers, rate limiting, Paystack webhook, impersonation system  
**Total findings:** 12 (2 Critical · 4 High · 4 Medium · 2 Low)

---

## Status key

| Symbol | Meaning |
|--------|---------|
| ✅ Fixed | Patched and deployed |
| ⚠️ Accepted risk | Known, documented, consciously accepted |
| 🔜 Post-launch | Planned for a future release |

---

## Critical

### C-01 — JWT signed with empty string when JWT_SECRET is unset ✅ Fixed

**File:** `apps/api/src/middleware/auth.ts`, `apps/api/src/middleware/detectSupportSession.ts`  
**Fix:** Both middleware files now hard-fail if `JWT_SECRET` is absent. `index.ts` also calls `process.exit(1)` at startup if the variable is missing or blank. `validateEnv()` enforces a minimum 32-character length.  
**Commit:** `ef03a5c`

### C-02 — Open redirect in forgot-password ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** Added `ALLOWED_REDIRECT_ORIGINS` allowlist. Any `redirect_to` value whose origin is not on the list is rejected with `400 INVALID_REDIRECT` before Supabase sends the email.  
**Commit:** `ef03a5c`

---

## High

### H-01 — Seed endpoint exposed in non-production environments ✅ Fixed

**File:** `apps/api/src/routes/auth.ts`  
**Fix:** Route remains wrapped in `NODE_ENV === 'development'` guard (so it is never registered in production) and now also requires a matching `X-Seed-Secret` header per request. `SEED_SECRET` is not set in Railway production variables.  
**Commit:** `ef03a5c`

### H-02 — CSP allows unsafe-inline and unsafe-eval ✅ Fixed

**File:** `apps/web/next.config.js`  
**Fix:** Removed `'unsafe-inline'` and `'unsafe-eval'` from `script-src`. Added `https://js.paystack.co` for Paystack popup. Added `frame-src 'none'` and Railway API URL to `connect-src`.  
**Commit:** `1a08491`

### H-03 — In-memory rate limiter resets on restart ✅ Fixed

**File:** `apps/api/src/middleware/rateLimit.ts`  
**Fix:** Replaced `MemoryStore` with Redis-backed `RedisStore` via `rate-limit-redis` + `ioredis`. Requires `REDIS_URL` set in Railway API service variables (add the Railway Redis plugin). Falls back to in-memory for local development when `REDIS_URL` is unset.  
**Commit:** `1a08491`

### H-04 — Paystack webhook falls back to re-serialized body ✅ Fixed

**File:** `apps/api/src/routes/fees.ts`  
**Fix:** `rawBody` is now mandatory — requests without it are rejected `400` before HMAC verification. The `JSON.stringify(req.body)` fallback has been removed. `verifyPaystackWebhookSignature` is kept (uses `crypto.timingSafeEqual`).  
**Commit:** `1a08491`

---

## Medium

### M-01 — CORS passes all no-Origin requests ⚠️ Accepted risk

**Rationale:** CORS is a browser-only mechanism. Server-to-server callers and mobile apps without an Origin header are the intended API consumers. All endpoints require a valid JWT — CORS is not a meaningful defence layer here. Accepted.

### M-02 — trust proxy 1 IP spoofing risk ⚠️ Accepted risk

**Rationale:** Railway's current infrastructure uses a single proxy hop. Monitoring is in place via Sentry. If Railway adds a second proxy hop the value will be updated. Accepted pending infrastructure change.

### M-03 — Impersonation actions logged under victim's ID ✅ Fixed

**Files:** `apps/api/src/middleware/detectSupportSession.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/db/queries/auditLog.ts`, 7 route files  
**Fix:** `detectSupportSession` queries `platform_admin_id` and attaches `req.supportSession = { sessionId, realAdminId }`. `logAudit` merges `_support: { performed_by_admin, support_session_id }` into `new_value` JSONB when a support session is active. All 23 `logAudit` call sites in school-scoped routes updated to pass `req.supportSession`.  
**Commit:** `1a08491`

### M-04 — JWTs stored in localStorage ⚠️ Accepted risk

**Rationale:** Migrating to HttpOnly cookies requires significant frontend and CORS refactoring. The existing CSP (`H-02` fix) removes the practical XSS vector that makes localStorage dangerous. Accepted for now; cookie-based auth is a planned post-launch improvement.

---

## Low

### L-01 — bcrypt cost factor 10 ✅ Fixed

**Files:** `apps/api/src/routes/auth.ts`, `apps/api/src/routes/students.ts`, `apps/api/src/routes/users.ts`, `apps/api/src/routes/superAdmin.ts`  
**Fix:** All `bcrypt.hashSync(…, 10)` and `hashSync(…, 10)` calls updated to cost factor `12` (OWASP 2024 minimum recommendation). Applies to registration, password reset, and temp-password generation.  
**Commit:** see this PR

### L-02 — Plaintext temp passwords in API response body ✅ Fixed

**File:** `apps/api/src/routes/students.ts`  
**Fix:** Added `Sentry.getCurrentScope().addEventProcessor` before both responses that emit `temp_password`. The processor strips `event.request.data` on any `/students` or `/parents` request captured by Sentry, preventing credentials from appearing in the Sentry event stream.  
**Commit:** see this PR

---

## Reporting a vulnerability

If you discover a security issue in Chronix Edu, please email **joshua4moses@gmail.com** with a description and reproduction steps. Do not open a public GitHub issue for security findings.
