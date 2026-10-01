# Sign-in rate limiting — remediation spec

Status: **partly implemented** — see "Where this stands" below (updated 2026-09-30)
Supersedes: Agent File **Rule S5** (see §0 — the rule must be amended, not worked around)
Depends on: `9e2e404` (separate Redis prefixes) — already deployed, keep it

## Where this stands

**Shipped (SECURITY.md Round 17):** §0 — S5 amended in `CLAUDE.md` "Spec drift". A
narrower §2.1/§2.3: `POST /login` has its own limiter (`rl:login:`) that counts only
failed attempts; every other `/api/auth` route keeps the counting-everything limiter.
`max` is **20** since SECURITY.md Round 19 — test 5 exists and, since Round 18, the key is the client.
Mounting lives in `mountRateLimiters()`, which index.ts and `rateLimitRedis.test.ts`
both call. Tests 1, 2 and the scope half of 4 are in `rateLimitRedis.test.ts`; **test 5
(corrected form, below) is `authLockout.test.ts`** — the lockout had no test before, since
`auth.test.ts` runs with `redis` null. `rateLimitRedis.test.ts` also pins the known limit
in the last paragraph: six correct passwords *arriving together* → one 429; six in
sequence → all admitted.

**Corrections to the text below, verified against code:**

1. **§2.3 as written reopens forgot-password.** It puts the `skipSuccessfulRequests`
   limiter on `/forgot-password`, which answers 200 whether or not the account exists —
   so it would never be counted, and it sends email. That is why only `/login` got the
   failures-only limiter.
2. **§3.2 understates the Redis dependency.** express-rate-limit 8.5.2 defaults
   `passOnStoreError: false`, and ioredis defaults `maxRetriesPerRequest: 20` with an
   offline queue: during a Redis outage *every* `/api` request waits through the retries
   and then fails through the general limiter — not just login. Two dependencies, two
   fixes, one fail-open/fail-closed decision (still open, Moses's call).
3. **Test 5's arithmetic.** The lockout refuses on the 5th failure itself
   (`emailAttempts >= MAX_ATTEMPTS`), not the 6th. The test that proves the widening
   safe: 5 wrong passwords for one email from 5 addresses, then the **correct**
   password from a 6th address — refused with `ACCOUNT_LOCKED`.
4. **§1a's per-IP lockout is weaker than it reads.** A successful login `DEL`s
   `login_attempts_ip:<ip>` (auth.ts), so anyone holding one valid account — any parent
   or student — resets their address's failure count between guesses. The per-email
   lockout is the guessing control; the per-IP one is not.

**§3.1, answered 30 Sep (SECURITY.md Round 18):** `req.ip` was never the client.
`X-Forwarded-For` carries two Railway addresses and no client; the client is `X-Real-IP`,
which the edge overwrites, so it cannot be forged through the edge. The one-in-five
"second key" was the same client via a different proxy; the same proxy served every
school. Fixed by `clientIp(req)`; `trust proxy` depth was never the lever. The raise of
`max` from 5 to 20 now has both prerequisites — test 5 exists, and the key is per client.

**Known limit of the shipped change:** the failures-only count is decremented when a
response is *sent*. Six correct logins from one address in flight at once (login takes
~2s) still count six while in flight, so the sixth is refused. Rarer than the defect it
replaces; the raise to 20 would remove it.

---

## 0. Rule S5 must be amended first

Agent File p.14, Rule S5, prescribes verbatim:

```js
app.use('/api/auth', rateLimit({ windowMs: 60000, max: 5 }))
app.use('/api',      rateLimit({ windowMs: 60000, max: 100 }))
```

`index.ts:122-123` implements exactly that. **The rule is the defect.** It has three
faults, and the code inherited all three:

1. It counts successful logins toward a limit whose only purpose is stopping guesses.
2. It keys on IP, which in a school is one NAT address shared by the whole staff.
3. It binds the limit to the whole `/api/auth` prefix, not to the routes that submit
   credentials.

Do not implement the changes below while leaving S5 as written — a later pass will
read the code as a rule violation and revert it. Amend S5 in the Agent File to the
policy in §2, note the supersession here, and record it in `SECURITY.md` as
Round 17.

---

## 1. Evidence

Railway HTTP logs for the API service, in the minute after `9e2e404` went live
(deploy SUCCESS 15:57:31 UTC, 2026-09-28):

```
15:57:45  POST /api/auth/login  200   2180ms
15:57:59  POST /api/auth/login  200   1717ms
15:58:05  POST /api/auth/login  200   1874ms
15:58:14  POST /api/auth/login  200   1781ms
15:58:20  POST /api/auth/login  200   1798ms
15:58:25  POST /api/auth/login  429      3ms   <-- sixth CORRECT password, refused
```

Five correct passwords in 35 seconds; the sixth refused in 3 ms, before the password
was checked. The dashboard GETs interleaved between them are now on the general
counter — `9e2e404` did what it claimed — but the limiter still counts successes,
so the wall is still there. Substitute six teachers on one staff-room router at
07:50 and the outcome is identical.

## 1a. The credential-keyed control already exists

`routes/auth.ts:149-183`:

- `login_attempts:<email>` — incremented on failure only, 5 = locked, 15 min TTL
- `login_attempts_ip:<ip>` — incremented on failure only, 20 = locked, 15 min TTL
- both `DEL`'d on success (`auth.ts:239`)

This is already the right shape: keyed on the credential under attack, counts only
failures, self-clearing. The 5/min IP limiter on top of it blocks nothing the lockout
doesn't already block, and it is the only one of the two that refuses correct
passwords. **Treat the lockout as the guessing control. Demote the limiter to a
flood backstop.**

---

## 2. Changes

### 2.1 `middleware/rateLimit.ts` — the auth limiter stops counting successes

In `createRateLimiters`, on the `auth` limiter only:

```ts
const auth = rateLimit({
  windowMs: 60_000,
  max: 20,                      // was 5 — see 2.2, this is now a flood backstop
  skipSuccessfulRequests: true, // a correct password is not a guess
  store: store('rl:auth:'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});
```

Note on `skipSuccessfulRequests`: express-rate-limit decrements on response when the
status is < 400. A 401 from a wrong password still counts; a 200 does not. That is
the intended split.

Leave `general` untouched.

### 2.2 Why 20 and not 5

With `skipSuccessfulRequests` the limiter now counts only failed attempts per IP per
minute. The per-email lockout already stops a single account being guessed after 5
failures. What remains for the IP limiter is a *flood* — many emails tried from one
address — and 5/min is far too tight for a shared school address where several people
mistype in the same minute. 20/min per IP against the 20-per-15-min IP lockout gives
one minute of noise headroom before the longer lockout takes over.

### 2.3 `index.ts` — scope the limiter to credential-submitting routes

Replace `app.use('/api/auth', authRateLimiter)` with the limiter applied inside
`routes/auth.ts` on these routes only:

- `POST /login`
- `POST /forgot-password`
- `POST /reset-password`
- `POST /confirm-reset`

Not on `POST /change-password` (already behind `verifyToken` — an authenticated user
changing their password has no business sharing the sign-in bucket) and not on
`POST /create-user` (already `requireRole('super_admin')`).

`/api/auth` keeps the general 100/min via the existing `app.use('/api', ...)`.

### 2.4 Escalating lockout (optional, do after 2.1–2.3 are live)

`LOCK_WINDOW_SECONDS` is a flat 15 minutes. A teacher who mistypes five times is out
for the morning. Consider a step: 1st lockout 60s, 2nd 5 min, 3rd+ 15 min, keyed by a
separate `login_lockouts:<email>` counter with a 24h TTL. Not required for this round;
raise as its own change.

---

## 3. Two checks that must pass before this ships

Both of these can invalidate parts of §2. Neither is currently verifiable from the
logs, because `requestLogger` does not record client IP.

### 3.1 `trust proxy` correctness

`index.ts:85` sets `app.set('trust proxy', 1)` — exactly one proxy hop. If Railway's
edge adds more than one, `req.ip` is a Railway address, **every school in the country
shares one counter**, and `MAX_IP_ATTEMPTS = 20` locks out the world on the first
sustained wrong-password run anywhere.

Check: add `ip` and `X-Forwarded-For` to the `http_request` log line temporarily (or
add a `GET /api/_debug/ip` behind super_admin), hit it from two known-distinct
networks, confirm two distinct addresses that are not Railway's. Remove the temporary
logging afterwards — client IP alongside school IDs is PII under NDPR.

If it turns out more than one hop is trusted: raise `trust proxy` to the real count
(never `true`, which lets a client spoof `X-Forwarded-For` and forge its own key) and
re-verify.

### 3.2 Login is a hard dependency on Redis

`auth.ts:155-161` does `await redis.get(emailKey)` inside the route's `try`. The
`catch` at `auth.ts:258` is `return next(err)`. If Redis is unreachable, `redis.get`
rejects and **every login in the system returns 500** — the `ioredis` error handler at
`rateLimit.ts:26` logs the error but `redisClient` stays truthy, so the `if (redis)`
guard does not fall back.

This is a larger availability risk than the rate limit was. Decide deliberately which
way it should fail, and write it down:

- **Fail open** — wrap the lockout reads/writes in their own try/catch, log
  `login_lockout_unavailable` at `error`, let the login proceed on the password check
  alone. Brute-force protection degrades to the IP limiter for the duration.
- **Fail closed** — keep current behaviour but return a 503 with a real message
  instead of a 500 from the generic error handler, so the cause is legible.

Fail open is the right default for a school at 07:50 on a Monday, but this is a policy
call, not a code cleanup — make it explicitly and record it in `SECURITY.md`.

---

## 4. Tests

Extend `rateLimitRedis.test.ts` (the fake-Redis harness from `9e2e404`, which drives
the only path production runs). Every test below must be shown **failing on current
`main`** before the fix lands — doctrine 16: a test that passes either way proves
nothing.

1. **Successes do not consume the auth allowance.** 30 requests returning 200 through
   the auth limiter; the 31st still passes. Fails on current code at the 6th.
2. **Failures do consume it.** 20 requests returning 401; the 21st gets 429.
3. **The two limiters remain independent.** Regression guard for `9e2e404` — 100
   general requests must not affect the auth counter and vice versa. (Exists; keep.)
4. **Scope.** `POST /api/auth/change-password` is not subject to the auth limiter:
   30 calls, none refused by it. Fails on current code.
5. **The per-email lockout still bites.** Integration, not unit: 5 failed logins for
   one email from *different* IPs → 6th refused with `ACCOUNT_LOCKED`. Proves the
   guessing control survives the limiter being widened. This is the test that makes
   raising `max` to 20 safe.
6. **`trust proxy`.** An assertion that `req.ip` differs for two requests carrying
   different `X-Forwarded-For` chains of the expected depth. Pins §3.1 so a future
   infra change that collapses all clients to one IP fails CI rather than production.

Test 5 is the important one. Tests 1–4 only prove the limiter got looser; 5 proves
nothing was lost by loosening it.

---

## 5. What this does not change

- Autoscaling. The 429 came back in 3 ms on an idle instance — that is a policy
  counter, not capacity. More instances share the same Redis counter and produce the
  same refusal. (Worth noting the inverse hazard: before `REDIS_URL` was set, adding
  instances would have *split* the counter and made the limit look generous —
  protection silently weakening as you scale. Keep `REDIS_URL` set on every replica.)
- Per-tenant exemptions. Removing the limit for a tenant removes brute-force
  protection for that tenant. The multi-tenancy problem is solved by keying the narrow
  control on the email (already done) rather than by exempting anyone.
