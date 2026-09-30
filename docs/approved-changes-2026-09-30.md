# Three approved changes — Redis fail-open, login limit 5→20, web build

Status: approved by Moses 30 Sep 2026, "go". Implement all three.
Order matters only in that (3) is independent — do it first or last, not interleaved.
Prior rounds: 16 (`3a4d1e7`), 17 (`c07c0b4`), 18 (`13c1157`).

---

## 1. Redis outage: fail open

**Decision: fail open.** Rate limiting is a mitigation; the per-email lockout is the
control; taking every school offline to preserve a mitigation is the wrong trade at
07:50 on a Monday. Record the decision and this reasoning in `SECURITY.md`, not just
the code change — the next person to read `passOnStoreError: true` needs to know it
was chosen, not defaulted (doctrine 8).

### 1.1 Two mechanisms, two fixes — neither covers the other

**a) The limiter stores.** `express-rate-limit@8.5.2`'s `passOnStoreError` defaults to
`false`, documented as "fail closed and block all requests if the datastore becomes
unavailable." `generalRateLimiter` is on `app.use('/api', …)`, so a Redis outage
currently 500s **every API request**, not just logins.

Set `passOnStoreError: true` on **all three** limiters (`general`, `auth`, `login`).

**b) The lockout's own Redis calls.** `auth.ts:155-183` calls `redis.get/incr/del`
directly. `passOnStoreError` has no bearing on these at all. The outer `catch` at
`auth.ts:258` is `return next(err)`, so any rejection 500s the login. The `if (redis)`
guard does not save it — the `ioredis` client object stays truthy while the connection
is down.

Wrap the lockout reads and writes so a Redis failure does not abort the login:

- On a **read** failure: log, skip the lockout pre-check, continue to the password check.
- On an **increment** failure after a wrong password: log, still return the normal
  `401 INVALID_CREDENTIALS`. Never convert a Redis fault into a 500 or into a lockout.
- On a **delete** failure after a correct password: log, still issue the token.

### 1.2 Logging, and an honest note about it

Both paths log at `error` with a distinct, greppable event name — suggested
`rate_limit_store_unavailable` and `login_lockout_unavailable` — including the error
message but **no credentials and no client address**.

Then state plainly in `SECURITY.md`: **nothing currently reads these logs.** There is no
alerting wired to Railway's log stream. A log line that nobody receives is advisory
output, which doctrine 9 says is indistinguishable from no output. So record the residual
explicitly rather than implying the window is covered:

> While Redis is unavailable, both brute-force controls are inactive — the per-IP
> limiter and the per-email lockout. The condition is logged at `error` and is not
> currently alarmed. Wiring an alert is an open item.

Do **not** build alerting as part of this change. Name it as an open item in
`docs/AUDIT-2026-09.md` and stop.

### 1.3 Tests — doctrine 16 applies directly

"Login succeeds when Redis is down" is also what a test with no lockout wired up
produces. Establish the working state first in the same test:

1. With a working fake Redis: five wrong passwords lock the account. **Assert it bites.**
2. Then make the fake throw on every command.
3. Assert the correct password now succeeds and a wrong one returns `401`, not `500`.
4. Assert the failure was logged at `error` with the expected event name.

Same shape for the limiter store: prove the limit bites with a working store, break the
store, prove requests pass. Both must fail on current `main` — verify by reverting the
change, not by assuming.

---

## 2. Login limiter: `max` 5 → 20

Both prerequisites now hold: `authLockout.test.ts` exists, and `13c1157` fixed the key
so the limiter counts the real client address rather than a Railway proxy.

### 2.1 Why 20 is the right number now

Post-`13c1157` the key is a school's public address, so one school's staff room is one
key — which is what the limit was always meant to measure and never did. With
`skipSuccessfulRequests`, the limiter now counts only **wrong** passwords. Twenty wrong
passwords per minute from one school is generous for Monday-morning typos and still
narrow enough to be a flood backstop.

The per-email lockout (5 failures / 15 min) is untouched and remains the control that
stops a single account being guessed. Nothing about this raise weakens it.

Leave `auth` (forgot-password, reset, change-password) at **5** — it counts successes by
necessity, and 5 deliberate password-reset requests a minute is already generous.

### 2.2 The concurrency window still exists and should be recorded

`skipSuccessfulRequests` decrements on response *finish*, and a login takes ~2s, so N
simultaneous logins all count until they start answering. At `max: 20` that means ~20
genuinely concurrent sign-ins before the 21st is refused, rather than 5. Your existing
deterministic test (hold at the handler, confirm waiting, release) should be updated to
the new boundary so the behaviour stays pinned rather than drifting.

### 2.3 Tests

- The existing per-email lockout test must still pass unchanged — five wrong passwords
  for one account from five distinct addresses, then the **correct** password from a
  sixth, refused. This is the test that makes the raise safe; if raising `max` breaks it,
  stop and reconsider rather than adjusting the test.
- Add: the 21st failed login in a minute from one address is refused; the 20th is not.
- Update the concurrency test to the new boundary.

---

## 3. Web service build — Railway config only, no code

The API was fixed to `npm ci && npm run build --workspace=@chronixedu/api` because
"`npm install` inside a workspace member bypasses the root lockfile, so production builds
were not reproducible and could drift from what CI tested" (CLAUDE.md, Migrations). The
web service still has the old form, and worse: `rootDirectory: /apps/web` means the build
cannot see `package-lock.json` at all. Every web deploy currently resolves dependencies
fresh against semver ranges.

**Verify locally before touching Railway.** From a clean checkout at the repo root:

```bash
rm -rf node_modules apps/web/node_modules apps/web/.next
npm ci
npm run build --workspace=@chronixedu/web
```

Confirm `apps/web/.next` is produced. Only if that succeeds, change the web service config
to mirror the API's:

| Setting | From | To |
|---|---|---|
| Root directory | `/apps/web` | *(unset — repo root)* |
| Build command | `npm install --prefer-offline=false && npm run build` | `npm ci && npm run build --workspace=@chronixedu/web` |
| Start command | `node node_modules/.bin/next start -p ${PORT:-3000} -H 0.0.0.0` | `cd apps/web && npm start` |
| Watch patterns | `/apps/web/**` | `/apps/web/**`, `/package.json`, `/package-lock.json` |

Notes:

- `apps/web/tsconfig.json` does **not** extend `tsconfig.base.json` (checked), so unlike
  the API, the web watch patterns do not need it.
- `npm start` in `apps/web` is `next start`; Railway supplies `PORT`, and Next binds
  `0.0.0.0` by default in production, so the explicit flags are not needed. If the deploy
  comes up but is unreachable, restore them as `cd apps/web && npx next start -p ${PORT:-3000} -H 0.0.0.0`
  rather than reverting the whole change.
- A failed **build** leaves the previous deployment serving, so that failure mode is safe.
  A build that succeeds with a broken **start command** is the one to watch: check the
  deployment reaches `SUCCESS` and the site actually loads before moving on.
- This touches `/apps/web/**` watch patterns, so it deploys the web service. It does not
  touch the API and does not run `migrate:prod`.

---

## Deployment awareness

(1) and (2) touch `apps/api/**`, so pushing them deploys the API **and runs
`migrate:prod` as pre-deploy**. Neither change adds a migration, so that step should be a
no-op — confirm with `SELECT * FROM migration_runs ORDER BY id DESC LIMIT 5` afterwards,
since Railway does not surface pre-deploy output in the API log stream.

## Definition of done

The full list in CLAUDE.md, plus: each new test verified to fail on the pre-change code by
actually reverting the change, not by inspection. Record (1) and (2) as SECURITY.md
Round 19 and give (3) its own commit, separate from both.
