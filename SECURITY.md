# Security Audit — Chronix Edu

**Latest audit:** Round 38 — 2026-10-06  
**Scope:** Where an online fee payment is credited  
**Round 38 total findings:** 1 (0 Critical · 0 High · 0 Medium · 1 Low) — remediated in code, not yet deployed

---

## Round 38 — 2026-10-06

### L-01 — An online fee payment was credited to whatever school and invoice its metadata named ✅ Remediated

**Files:** `migrations/062_fee_checkouts.sql`, `apps/api/src/db/queries/feeCheckouts.ts` (new), `apps/api/src/routes/fees.ts` (`POST /:schoolId/payments/paystack/initiate`), `apps/api/src/routes/feesPublic.ts` (the return page and the webhook).

**Raised by the reviewer** (6 Oct 2026) while reviewing the account-wide webhook, which is parked for the second school (branch `parked/paystack-account-webhook`). The weakness was already live, without it.

**The mechanism.** Nothing was written on our side before Paystack was called. The return page and the webhook took the invoice from the metadata on Paystack's record of the transaction. The return page cross-checked it against a school id in its own address, which whoever calls it chooses; the webhook against the one school in the address set in Paystack's dashboard. So a transaction created on the same Paystack account another way (Paystack's own pay widget with the account's public key, or a payment page) could name any invoice and be credited to it, while the money went wherever that transaction sent it: to Chronix's own balance rather than the school's.

**Why Low.** It needs a transaction created outside the app on Chronix's own Paystack account. The app never publishes the public key (the web makes no client-side Paystack call). And nothing is stolen: the payer pays real money. The harm is an invoice shown as paid for money the school never receives.

**Fix.** The pattern Chronix's own subscription payments already use (migration 052):
- **Starting a payment writes its record first:** the reference Paystack will report, the school, the invoice, the amount and who started it.
- **The return page and the webhook credit only through that record:** its school and invoice, and only when Paystack verifies exactly its amount, in naira. Paystack's metadata and the school in either address are not used.
- **A payment no record started is not credited.** It raises `fee_payment_not_credited`, and the bursar records it by its reference once checked. The same alert covers a verified amount other than the record's.
- **Credited once,** whichever delivery arrives first: payments' UNIQUE Paystack reference holds two simultaneous deliveries (tested).
- Because a payment is matched by its reference, the pilot's own webhook address now credits every school's payments correctly; Chronix's subscription payments arriving there are settled by their reference too. Any other Paystack event is logged by name, not dropped silently.

**Tests:** `feeCheckouts.db.test.ts` (12), including the reviewer's mirror of `platformBillingFullStack.test.ts`: metadata naming another school and invoice is credited to the record's.

---

## Round 37 — 2026-10-05

### M-01 — Student photos, signatures and homework sat in a public bucket ✅ Remediated (live 6 Oct 2026; the bucket is private)

**Files:** `apps/api/src/services/schoolAssets.ts` (new), `migrations/061_school_assets_store_paths.sql`, the five image uploads (`routes/schools.ts` logo, signature, stamp; `routes/users.ts` staff signature; `routes/students.ts` photo), `routes/assignments.ts`, the school, `/users/me` and student-profile reads, `apps/web/next.config.js`.

**Found** while surveying files for the data export (2 Oct 2026, WORKING-CHECKLIST X). A demo student's homework answered HTTP 200 to an unauthenticated request for its public link.

**The mechanism.** `school-assets` was a public bucket. Each upload stored a public link (`getPublicUrl`). That link opened the file for anyone who had it, signed in or not, for ever: it could not be withdrawn short of deleting the file. Links travelled in API responses, audit rows and the web pages that showed them. The paths carry UUIDs, so the links could not be guessed; they could be forwarded. `routes/assignments.ts` minted 15-minute signed links for homework, which the public bucket made decorative.

**Fix.**
- **A record stores the file's path,** never a link. Migration 061 converts the stored public links (production: the pilot's logo and signature) and touches nothing else.
- **A screen gets a link that expires in 15 minutes,** made on each read and never cached: the school record, `/users/me` and the student profile. The 5-minute school cache keeps the paths.
- **A PDF gets the image itself** (`assetDataUri`), read with the service role, so report cards, previews, receipts and transcripts work while the bucket is private.
- **The offline cache keeps no copy** of a bucket file.
- **The switch.** Moses made the bucket private in the Supabase dashboard on 6 Oct, before the deploy rather than after it, so the pilot's logo and signature did not load until the code went live at 06:36 UTC. Every link ever handed out stopped working at once: both of the pilot's old public links answered 400 after the deploy, and the stored values were paths matching their files.

**Accepted:** a file someone already downloaded cannot be recalled. Production held 4 files in the bucket, all the pilot's or test data.

### M-02 — The PDF renderer fetched any address in the school's logo or stamp field ✅ Remediated

**Files:** `apps/api/src/services/schoolAssets.ts` (`refuseNetwork`, `assetStoragePath`), `routes/schools.ts` (`PATCH /:schoolId/identity`), `services/reportCardService.ts`, `receiptService.ts`, `transcriptService.ts`.

**Found** while mapping the readers of the bucket for M-01 (5 Oct 2026).

**The mechanism.** `PATCH /:schoolId/identity` accepted `logo_url` and `stamp_url` as any URL (`z.string().url()`). The web never sent them, but the API took them. Report cards, previews, receipts and transcripts wrote the stored value into `<img src>`, and Chromium fetched it from inside Railway's network. So a principal could make the server request an internal address (`*.railway.internal`, for example). Only an image response would show; the request itself still went.

**Fix.**
- **The route refuses an image field by name** (400 `SET_BY_UPLOAD`): each has its own upload.
- **A PDF page fetches nothing.** Images arrive inside the page, and `refuseNetwork` aborts every request that is not a `data:` URI. Measured with the installed Puppeteer: a `data:` image renders (also with Handlebars' escaped `=`), and a page asking for an address on a local server it controlled caused 0 requests.
- **A stored value that is an address is never read:** `assetStoragePath` returns null for anything but a path or a link to this bucket.

### L-01 — The registrar's screens showed, and printed, each new parent's working password ✅ Remediated

**Files:** `apps/api/src/routes/students.ts` (`POST /:schoolId/students`, `POST /:schoolId/students/:studentId/parents`), `apps/web/app/(dashboard)/registrar/students/page.tsx`, `.../[id]/page.tsx`.

**Found** while mapping every path that sets a password (5 Oct 2026).

**The mechanism.** H2 (1 Oct 2026, Round 29) took the password out of the parent's welcome email: a parent sets their own with Forgot password. The two routes that create a parent still returned the random password, and the registrar's screen showed it and printed it on the credentials slip. Staff held a working login to each parent account, which reads a child's results and fees, and anything done with it would be recorded as the parent.

**Fix.** Neither route returns a parent's password. The screen and the slip say how a parent sets one (the sign-in page, then Forgot password); the slip remains the fallback when the welcome email is not sent. The bulk-import sheet already left parents' passwords out. A student's temporary password is still shown, because most students have no email to reset with (H2's scope, unchanged).

### L-02 — A platform admin's password reset or change was recorded nowhere ✅ Remediated

**Files:** `apps/api/src/routes/auth.ts` (`auditOwnPasswordChange`).

`confirm-reset` and `change-password` audited only a user with a school (`if (local.school_id)`), so a platform admin's reset or change left no row in either audit table. Recorded as an open item on 2 Oct 2026; the root admin's reset on 5 Oct was the first one seen. Both now write `platform_audit_logs` for a user without a school (`PASSWORD_RESET_COMPLETE`, `PASSWORD_SELF_CHANGE`, with the address).

### L-03 — A password reset wrote Supabase and our copy in two separate steps, and Redis outside `bestEffort` ✅ Remediated

**Files:** `apps/api/src/routes/auth.ts`, `apps/api/src/db/queries/users.ts` (`changeOwnPassword`).

`confirm-reset` set the Supabase password, then updated `users.password_hash` with no transaction and an ignored result: a failure between them left the two disagreeing. It also wrote the `must_change_password` cache with a bare `redis.set`, so a Redis outage failed a reset that had already changed the password (Round 19). Both routes now set a password through `changeOwnPassword`: one transaction, the account row locked, Supabase called before COMMIT and rolled back with it. The cache write goes through `bestEffort`.

### L-04 — Every correct password reset raised a false alert (CHRONIXEDU-API-5) ✅ Remediated

**Files:** `apps/api/src/routes/auth.ts`, `apps/api/tests/passwordResetSessions.test.ts` (new).

**Found** from the root admin's reset on 5 Oct 2026, the first through the Round 35 path.

**The mechanism.** Setting a password through Supabase's admin API ends every Supabase session of the account, the reset link's own included. The route's own global sign-out then found its session gone (`session_not_found`, "Auth session missing!") and logged `password_reset_sessions_not_revoked`, which alerts. Afterwards the account had 0 sessions and 0 live refresh tokens. The guarantee held; the alarm was false, and would have fired on every reset. An alarm that always fires is ignored.

**Fix.** That one error (`isAuthSessionMissingError`) is logged as done (`password_reset_sessions_already_ended`, info); any other failure still alerts. A CI test against Supabase's local stack holds the premise: two signed-in sessions and the link's own all stop refreshing after a reset. If Supabase ever stops ending them, CI fails instead of the alarm going quiet.

### Info — No password can be reused within 60 days (Moses, 5 Oct 2026)

**Files:** `migrations/060_password_history.sql`, `apps/api/src/services/passwordReuse.ts`, `passwordHistoryRetention.ts`, `db/queries/passwordHistory.ts`, `db/queries/users.ts`.

A new password is refused (400 `PASSWORD_RECENTLY_USED`) when it matches the account's current one or one it replaced in the last 60 days, on both paths a person sets their own. The replaced bcrypt hashes are a credential store of their own: RLS with the service-role bypass only, every grant revoked from `anon` and `authenticated`, never exported, deleted with the user and the school, and nothing older than 60 days kept (deleted on each change and daily at 03:20 Lagos). It cannot see a password set in the Supabase dashboard.

Also: a wrong current password on Change password answered 401, which the web treats as a lapsed sign-in, so the person was signed out and never saw the message. It answers 400.

### Info — A critical `proxy-addr` advisory stopped CI; it could not reach the API (6 Oct 2026)

**Files:** `package-lock.json` (`proxy-addr` 2.0.7 → 2.0.8, `5593b95`).

GHSA-jqcg-44mw-7w3h (critical, CVSS 9.1: IP spoofing through an IPv4-mapped IPv6 trust subnet) reached npm's audit data overnight, so the security gate failed CI run 37421462048 before any test ran, and Railway skipped both deploys. The fix is the patched release Express already accepts, a lockfile-only change; there was nothing to allowlist.

It could not have touched the API, by design rather than luck. `proxy-addr` decides `req.ip` under Express's `trust proxy`, and since Round 18 the API reads the client's address from `X-Real-IP` through `clientIp(req)`, never `req.ip`: the rate limits, the sign-in lockout and both audit tables' `ip_address`. That decision was taken because Railway's headers made `req.ip` a proxy's address; it kept this advisory out of reach as well. (`trust proxy` is also a hop count, 1, not the subnet form the advisory concerns.) Keep `clientIp` the only reader: a new `req.ip` reader is a regression on both counts.

---

## Round 36 — 2026-10-04

### L-01 — A deleted school's users kept working sessions for up to 5 minutes ✅ Remediated

**Files:** `apps/api/scripts/delete-school-data.js`, `apps/api/src/middleware/auth.ts`, `apps/api/src/config/cacheTimes.json` and `cacheTimes.ts` (new), `apps/api/src/services/cacheService.ts`, the seven Redis writers of `user_active` and `must_change_password`.

**Found** while recording 2FA commit 4's fail-closed rule for a missing account row (`docs/AUDIT-2026-09.md`). The reviewer traced the path that reaches it: deleting a school.

**The mechanism.**
- **Two caches answer without the database.** `requireActiveSchool` serves a school from an in-process cache for 5 minutes, and `verifyToken` trusts a `user_active` "1" in Redis for 5 minutes.
- **The deletion cleared neither.** `delete-school-data.js` is a separate process, and has no Redis access.
- **A missing row read as yes.** `is_active !== false` and `must_change_password === true` both answered the permissive way for a row that was gone.
- **So,** for up to 5 minutes after a school was deleted without first being suspended, its users' live tokens passed the whole `/api/schools` chain. The school's rows were gone and every `school_id` table has a foreign key to `schools`, so as far as measured nothing could be read or written; it was still access that should have ended. It is the path a real customer's offboarding takes.

**Fix.**
- **The script suspends, waits, re-checks.**
  - **Suspends** every school it will delete.
  - **Waits** the longest time in the shared `config/cacheTimes.json` plus 15 s.
  - **Re-checks** inside each school's transaction, with the row locked, refusing unless the school is still suspended.
  - It holds at any replica count, and whatever suspended the school.
- **A token whose account row is gone is refused** (401 `ACCOUNT_NOT_FOUND`), for every role.
- **The cache times live in one file,** read by the API and the script. `cacheTimes.test.ts` fails on a typed-in expiry. Before, the same 300 was typed seven times, and two reviews each miscounted the copies.

**Accepted:** a `user_active` "1" cached while the row existed can still answer for up to its cache time after the row goes. The suspend-and-wait makes that harmless for a deleted school.

### L-02 — A revoked support token's revocation could expire before the token ✅ Remediated (latent: never live)

**Files:** `apps/api/src/config/supportSession.ts` (new), `apps/api/src/config/env.ts`, `apps/api/src/routes/superAdmin.ts`, `apps/api/src/services/supportSessions.ts`.

**Raised by the reviewer.** `SUPPORT_SESSION_MAX_DURATION_HOURS` was read three ways:
- the token's life read it as text;
- the token store, which ending a session reads to find the token, used `parseInt`;
- the revocation list ignored it and always kept an entry for 30 minutes.

**What it would have done.** At `2`, a revoked token's entry expired 90 minutes before the token. At `0.5`, the store kept the token for 60 s of its 30 minutes, so ending a session revoked nothing.

**Why it was latent.** The variable is not set in production (checked 4 Oct 2026), so all three were 30 minutes. The revocation list is also the second check: `detectSupportSession` refuses a session whose `ended_at` is set, from the database, and `verifyToken` makes the session header mandatory. The reviewer's first reading, that a revoked token would be accepted again, was withdrawn once that gate was traced.

**Fix.** The setting is read once, in seconds, and all three come from that number; the store and the list outlive the token. A value that cannot be honoured stops the API at boot. `supportSession.test.ts` covers a whole and a fractional setting.

---

## Round 35 — 2026-10-03

### H-01 — Every sign-in left a Supabase session that never expired, and any session's token could reset the password ✅ Remediated

**Files:** `apps/api/src/services/passwordCheck.ts`, `apps/api/src/services/resetLink.ts` (new), `apps/api/src/supabaseClient.ts`, `apps/api/src/routes/auth.ts` (`POST /login`, `POST /confirm-reset`), `apps/api/src/routes/schools.ts` (the payout step-up), `apps/api/src/db/queries/users.ts`.

**Found** while building the 2FA password re-check (2FA commit 2). Verified independently by the reviewer in production.

**The mechanism.**
- **Every password check created a session.** `POST /login` and the payout step-up called `signInWithPassword` on the shared anon client. Each call created a Supabase session whose refresh token never expires.
- **The shared client kept one.** It used supabase-js's server defaults, so it also held the most recent session in memory and kept refreshing it.
- **The app never used any of them.** It signs its own JWT, so nothing ever revoked them.

**What was standing** (3 Oct 2026, counts only):
- **56 sessions with 56 live refresh tokens, for 7 accounts.** That is every account that can sign in, the root admin included.
- **`not_after` is NULL on all of them,** the oldest from 19 Aug. Only 2 were refreshed in the last week.
- **55 came from sign-in** (`amr` method `password`). Their refresh tokens never left Supabase and the API's memory: the API signs in server-side, and the web never talks to Supabase.
- **1 came from a password-reset link** (`otp`). Its tokens reached a browser, in the address fragment the reset page reads and clears.

**Why it was serious.**
- **The reset route took any token.** `POST /confirm-reset` takes `password`, `confirm_password` and `access_token`, and no current password. It accepted any valid access token for the account.
- **Every session could mint one.** A live session mints a fresh access token whenever it likes.
- **So each lingering session was a standing password reset,** reached without passing through sign-in. Sign-in is where 2FA commit 3 puts the second factor: shipped on top of this, the protection would have had a bypass beside it.
- **The second place.** Supabase's REST endpoint lets such a token read its owner's own `users` row.

**Fix, in three parts, in order:**
1. **Revoke what exists.** `DELETE FROM auth.sessions`, which cascades to `auth.refresh_tokens` and `auth.mfa_amr_claims`. Run by Moses in the SQL editor (production deletions are his to run). It signs nobody out of the app, which runs on its own JWT. It is run again after this fix deploys, for the sessions sign-ins made in between. The counts are recorded in `docs/AUDIT-2026-09.md`.
2. **Stop making them.**
   - **One check.** `signInAndRevoke` (`services/passwordCheck.ts`) is now the only way the API checks a password, for sign-in, the 2FA re-check and the payout step-up. It revokes the session it creates at once (admin `signOut`, that session only).
   - **No client keeps a session.** Both Supabase clients are created with `persistSession: false` and `autoRefreshToken: false`.
   - **A failed revocation alerts** (`supabase_session_not_revoked`), and never fails the check.
3. **Re-examine `confirm-reset`.**
   - **Kept: no current password.** That is what a reset is for: the person has lost it, and the emailed link is the proof.
   - **Changed: what counts as a reset.** Only a reset link's own session counts (`amr` method `otp` or `recovery`, never `password`), and only within 60 minutes of the link being opened. The `amr` timestamp survives refreshes, so a reset session left open cannot be used later.
   - **Changed: once only.** A completed reset revokes every Supabase session of the account (`signOut` scope `global`), the link's included. It also ends the account's app sessions (`users.sessions_valid_after`, enforced for platform admins' tokens today).
   - **A refused token** gets the same answer as an expired link, and its reason is logged, never the token.

**Verified in production, 3 Oct 2026:**
- **The fix went live** at 18:55:14 UTC (deploy `c913e26e`, migration run 100, `8fac70a`).
- **The revocation:** Moses then ran it once in the SQL editor. No sign-in had happened since 15:06 UTC, so one run covered everything. Sessions went from 56 to 0, live refresh tokens 0, `amr` claims 0, checked from here and by the reviewer.
- **The discriminator:** a sign-in at 19:15:34 UTC left the count at 0. Before the fix, every sign-in added a permanent row.

**Correction to the reviewer's note:** the sign-in refresh tokens were not in any browser's `localStorage`. The web stores only the app's own token, and never received a Supabase one. The one session whose tokens did reach a browser was the reset link's. The fix and the revocation are unchanged by this.

**Tests:**
- `passwordCheck.test.ts`:
  - the session is revoked, and only that one;
  - nothing is revoked for a wrong password;
  - a failed revocation is logged, never the tokens.
- `supabaseClientConfig.test.ts`: both clients keep no session and refresh nothing.
- `resetLink.test.ts`: a fresh reset link resets; a sign-in session does not, however fresh; a reset session over an hour old does not; an unreadable token does not.
- `auth.test.ts`:
  - sign-in revokes its session, and the token never reaches the response;
  - a sign-in token cannot reset, and changes nothing;
  - an old link cannot reset;
  - a completed reset revokes globally and ends app sessions.
- Each guard was broken on purpose and its tests failed:
  - no revocation (4 tests);
  - any token resets (5);
  - no global revocation (1);
  - default client settings (1).

**This also changes Round 33 H-02** (below). Changing a password does not invalidate an existing Supabase session, so rotation alone never closed it.

---

## Round 34 — 2026-10-03

### M-01 — The web app's Sentry sent API addresses with their query strings, and replay ran where a page holds a credential ✅ Remediated

**Files:** `apps/web/lib/sentryScrub.ts` (new), `apps/web/instrumentation-client.ts`, `apps/web/sentry.server.config.ts`, `apps/web/sentry.edge.config.ts`, `apps/web/components/NoReplay.tsx` (new), the sign-in and platform-admin layouts.

**Found** by the reviewer's request, on 2FA commit 2, to run the plant-and-search test against the web's Sentry as well as the API's (Round 33). It also settles the item Round 33 left open.

**Measured** with the browser SDK this app ships (`@sentry/browser` 10.58.0, inside `@sentry/nextjs`), under Node, against a fake ingest on 127.0.0.1:
- A real `fetch` to `/api/schools/x/students?search=…` became a breadcrumb carrying the full address. Breadcrumbs go out with every error and trace, so a search term (a student's name) reached Sentry.

**Reasoned, not measured** (rrweb cannot run without a DOM):
- **The reset token.** Session replay records the page's full address when it starts. The password-reset page arrives with `#access_token=…`, and the page clears it only in a `useEffect`, after Sentry has started. Replay samples 10% of sessions.
- **The 2FA QR code.** The reviewer's case for commit 2: it is drawn into the page, and replay's text and input masking does not cover a drawn image.

**What Sentry holds** (counts only, 3 Oct 2026):
- `chronixedu-web` has no error events in 90 days.
- It holds page-load traces (`/login`, `/super-admin/dashboard` and others), whose fetch spans carried full addresses.
- Replays cannot be counted through the API used here. **[MOSES]**: in Sentry → Replays, delete any replay of `/reset-password`.

**Fix:**
- **Addresses lose their query string and fragment** (`scrubEvent`, `scrubBreadcrumb`), in every error, trace, span and breadcrumb. Client-address attributes go too. The same rules run in the browser, the Node server and the edge runtime.
- **Session replay never starts** on the sign-in pages (`/login`, `/forgot-password`, `/reset-password`) or anywhere under `/super-admin` (`replayAllowed`). It is decided when the page load begins. `NoReplay`, mounted by both layouts, stops it when one of those pages is reached by client-side navigation. It stays off until the next full load.
- `@sentry/browser` is now a declared dev dependency of the web app, at the exact version `@sentry/nextjs` already installs, so the test runs the SDK the app ships. The security gate's report is unchanged.

**Tests:** `apps/web/lib/__tests__/sentryScrub.test.ts` (5).
- **The real-SDK test:**
  - **The planted values:** a search term in a real fetch, a reset token in a navigation and a page address, a page query string, and a header.
  - **The search:** everything the ingest received.
  - **The control:** the events, the fetch breadcrumb and the paths all arrive.
  - **Against no-op rules:** it fails at the first planted value.
- **The rules, directly:** paths, the replay decision (with allowed paths as the control), and the trace and span attributes.

**Not measured, and stated as such:** replay in a real browser. The protection does not depend on masking: replay is not running on those pages.

---

## Round 33 — 2026-10-03

### H-01 — The API sent passwords, login tokens and request data to Sentry ✅ Remediated

**File:** `apps/api/src/config/sentry.ts`.

**Found** while scoping two-factor sign-in for platform admins: a recovery code must never reach Sentry, so what reaches Sentry today was measured first.
- **The configuration.** `Sentry.init` named only `httpIntegration()`, so the SDK's defaults applied. They record the incoming request's body (up to 10 KB), its headers, cookies and query string. That record goes onto every error event and every sampled trace.
- **The measurement.** The API's exact options were run against a fake Sentry ingest on 127.0.0.1. Then:
  - a `POST /api/auth/login` that errored sent the typed password and the email;
  - a traced login that **succeeded** sent them too;
  - every request sent its `Authorization` bearer token, `x-support-session-id` and `x-health-token`.
- **The exposure.**
  - Production samples 20% of requests as traces, so about one login in five sent its password to Sentry, and every sampled authenticated request sent a live session token, a super admin's included.
  - The DPA names Sentry a sub-processor for technical data only (CLAUDE.md, Conventions), and this was neither.

**What Sentry holds now** (checked 3 Oct 2026, by counts only; no event was opened, so no secret was read back):
- **Traces:** no POST trace of any kind in the 90-day window, so no traced login. GET traces exist for super-admin pages and the dataset export. By the measurement, those carry a bearer token. Tokens expire after one hour, so every stored one is dead.
- **Errors:** four events in 90 days. One is `POST /api/auth/reset-landing`, whose body by design carries no address and no token. Three have no request.
- **Not checked:** whether the Sentry project's server-side data scrubbing ("Use Default Scrubbers") is on. It is a dashboard setting, and it would be a second layer, not the fix.
- **Not known:** what earlier traces held before they aged out. That is H-02 below, a separate item. It is not the rotation of the two passwords leaked through git (Round 23), which closes when those two are changed.

**Fix:**
- **The body is never read.** `httpIntegration({ maxIncomingRequestBodySize: 'none' })`.
- **Every error and every trace is cut down before it is sent** (`beforeSend`, `beforeSendTransaction`, `scrubRequest`):
  - the request keeps its method and its path;
  - headers, cookies, body and query string go;
  - query strings and client-address attributes are removed from the trace's attributes, its spans and its breadcrumbs, where the measurement also found them (`http.query`, `http.url`, `http.target`, and `http.client_ip` from `X-Forwarded-For`).
- **`sendDefaultPii: false`** is stated rather than left to a default.

**Tests:** `sentryScrub.test.ts` runs the real options against a local ingest.
- **The requests:** one login that errors and one that succeeds under tracing. Each carries a secret in every place a request carries one: the body (password and email), `Authorization`, `x-support-session-id`, `x-health-token`, a cookie, the query string, `X-Real-IP` and `X-Forwarded-For`.
- **The search:** it covers everything Sentry received, not one field.
- **The control:** it first asserts the error and the trace both arrived and name the route, so a Sentry that sent nothing cannot pass.
- **Against the old options:** it fails at the first secret, the password.

**Not changed, and open:** the web app's browser SDK may record API URLs, query strings included, as fetch breadcrumbs. This is unmeasured (`docs/AUDIT-2026-09.md`). The web server receives no password and no token: the browser sends both straight to the API.

### H-02 — Every password typed into production since 16 Jun 2026 must be treated as exposed 🟡 Open

**Why it is its own item.** H-01 is fixed in code. What it sent cannot be recalled, and cannot be checked: a trace that aged out of Sentry is gone from view, not proven harmless.
- **The window:** the API has run Sentry with 20% tracing since 16 Jun 2026 (`078d206`). Every sampled login sent its password.
- **Not the same as the git leak:** the rotation item from Round 23 covers the two passwords that leaked through git, and closes when those two change. This one is wider, and does not close with it.

**Who:** every account that can sign in. Production has seven logins (`auth.users` joined to `users`, 3 Oct 2026), and all seven signed in after 16 Jun: the super admin, a principal, a teacher, a parent, a bursar and two students. A user row without a login had no password to send. Names and addresses stay out of this repository.

**Closes when both are true** (corrected 3 Oct 2026, Round 35). As first written it would have closed on rotation alone while the exposure stood.
1. **Rotation.** Each of the seven has a new password set after H-01's fix went live in production. Before the fix, a new password was exposed again the next time it was typed. It is checked mechanically, not by asking: a fingerprint of each stored password hash was taken when the fix went live (kept outside the repository), and a changed fingerprint is a changed password.
2. **Revocation.** Every Supabase session of those accounts is revoked, after Round 35's sign-in fix is live. Changing a password does not invalidate an existing Supabase session, and a session's token could reset the password with no current password (Round 35 H-01). **Done, 3 Oct 2026:** 56 sessions to 0 after the fix went live, and a later sign-in left none. Only rotation remains.

Tracked in `docs/AUDIT-2026-09.md`.

---

## Round 32 — 2026-10-03

### L-01 — No school audit row had ever recorded an IP address ✅ Remediated

**Files:** `apps/api/src/db/queries/auditLog.ts` (`logAudit`, `logSettingsChange`), `apps/api/src/db/queries/scores.ts` (the batch audit insert), `apps/api/src/db/queries/platformBilling.ts`, and every route that audits (46 `logAudit` calls and 6 `logSettingsChange` calls in 16 route files).

**Found** by the reviewer on the first two `SCHOOL_DATA_EXPORTED` rows: both had `ip_address: null`. It was not that route.
- `logAudit`'s INSERT never named `ip_address`, and the only other writer, the score batch, did not either.
- Production held **262 `audit_logs` rows, 0 with an address**, ever.
- CLAUDE.md said "the audit `ip_address` column goes through `clientIp`", and that rows before 30 Sep "hold proxy addresses". That was true of `platform_audit_logs`, which `superAdmin.ts` writes directly, and false of `audit_logs`, which holds every school-level sensitive write: scores, results, settings, payments and exports.

**Fix: the compiler enforces it.**
- `AuditLogEntry.ipAddress` is required (`string | null`), and so is the batch's `opts.ipAddress`. A call that does not state an address does not compile, now or later.
- Every request-time call passes `clientIp(req) ?? null`.
- `null` is written, with the reason in a comment, where there is no request, or where the request is not the actor's own: the fee webhook (Paystack's server) and platform settlement.
- **A request context was tried first and rejected.** One middleware writing the address into `AsyncLocalStorage` would have reached every call without touching them. Measured: `multer` resumes from stream events and loses the context, so every upload's audit row (logo, stamp, signature, photo, assignment) would have recorded null without a word.

**Not changed:** the 262 existing rows stay as written. Their addresses were never captured, and nothing can recover them.

**Tests:**
- `auditLog.test.ts`: the INSERT names `ip_address` and passes the caller's address.
- `schoolExportArchive.db.test.ts`: both export rows carry the address from `X-Real-IP`.
- The compiler is the ratchet: removing `ipAddress` from any call fails `tsc`.

---

## Round 31 — 2026-10-03

### L-01 — A verified Paystack payment's currency was never checked ✅ Remediated (defence in depth: the account is NGN-only)

**Files:** `apps/api/src/services/paystackService.ts` (`isNairaPayment`), `apps/api/src/routes/fees.ts` (recording a payment by its Paystack reference), `apps/api/src/routes/feesPublic.ts` (callback and webhook), `apps/api/src/db/queries/platformBilling.ts` (`settlePayment`), `apps/api/src/routes/platformBillingPublic.ts` (callback and webhook), `apps/api/src/config/alerts.ts`, and the two screens a payment returns to.

**The defect.**
- `verifyPaystackTransaction` reports the currency Paystack charged in, and five places use its result: the bursar's record-by-reference, the fee callback and webhook, and the platform-billing callback and webhook.
- None of them read the currency. Each compared only the number, and treated it as kobo.
- So a payment in another currency, with the right figure and metadata, would have been recorded as that many kobo: 80,000 US cents settling an ₦800 bill.

**The direction of the harm** (corrected by the reviewer: the first account read it as a way to underpay).
- The kobo is the cheapest minor unit among the currencies Paystack supports (NGN, GHS, ZAR, KES, USD), so the payer always overpays: $800 for ₦800 is about 1,400x, R800 about 86x, GHS 800 about 100x.
- Nobody gets fees for free this way. The harm is money that arrived and must be refunded in a currency Chronix does not hold, recorded as something it is not: a reconciliation and liability problem.
- **Defence in depth today, not a live hole.** The Chronix Paystack account is NGN-only (checked 3 Oct 2026 in the dashboard, reported by Moses), so Paystack cannot create a charge in another currency at present. The exposure opens the day any other currency is enabled on the account, and this fix is what then stops it. Enable one only after re-reading this entry.

**Fix.**
- **One check, used by all five:** `isNairaPayment`, in `paystackService.ts`.
- **Each path refuses non-NGN money and says so:**
  - the bursar's record-by-reference answers 400 `PAYMENT_NOT_NAIRA`, naming the currency;
  - the fee callback redirects with `reason=wrong_currency`, and the parent's fees page explains it;
  - the fee webhook answers 200 (so Paystack stops retrying), `processed: false`, `reason: 'not_naira'`;
  - `settlePayment` takes the verified currency and fails the pending platform payment (`currency_mismatch`), as it already did for an amount mismatch. The billing page explains it.
- **Nothing is recorded, and every refusal alerts** (`payment_not_naira`: `paystack_payment_not_naira`, `platform_billing_currency_mismatch`), because the money may have arrived and need refunding.

**Tests:**
- `paymentCurrency.db.test.ts` (new, 2), both failing on the previous code, where the dollar fee came back `payment=success` and the dollar platform payment `settled`:
  - through the real fee callback and database, a naira payment pays an ₦800 invoice, and the same 80,000 in US cents records nothing, leaves the invoice unpaid and alerts;
  - `settlePayment` settles a naira payment, and fails and alerts on the same figure in USD.
- Unit, one per path beside its existing naira case:
  - the bursar's 400;
  - the fee callback's redirect;
  - the fee webhook's unrecorded acknowledgement;
  - the platform callback passing the currency and redirecting with the reason.
- **The mocks.** `fees.test.ts` and `feesPublic.test.ts` auto-mocked the whole Paystack module, which turned the new check into a stub answering `undefined`: every naira success test was refused. They now keep the stubs for Paystack's calls and run the real check.

---

## Round 30 — 2026-10-02

### M-01 — A new platform admin was emailed their password in plain text ✅ Remediated (never exercised)

**Files:** `apps/api/src/routes/superAdmin.ts` (`POST /admins`, `POST /admins/:id/resend-welcome`), `apps/api/src/services/welcomeEmail.ts`, `apps/web/app/super-admin/admins/page.tsx`, `apps/web/lib/superAdminApi.ts`.

**The risk.**
- `POST /admins` took a password the root admin typed and set it on the new account.
- It then emailed that password in plain text: "Email: … Password: …". This is the H2 defect (Round 29) on the account type that can reach every school.
- The password lived on in the mailbox and in SendGrid. If SendGrid refused the email, it also lived in `email_queue`, now for 7 days.
- A mistyped address handed a stranger a working super-admin login, and the root admin knew every platform admin's password.

**Never exercised.** The proof is the audit trail, checked 2 Oct 2026:
- The route writes `PLATFORM_ADMIN_CREATED` to `platform_audit_logs`, and waits for it, before it sends the email. If that insert fails, the route stops before sending. So a send leaves that row behind.
- Production's `platform_audit_logs` holds 15 action types and not one `PLATFORM_ADMIN_CREATED`.
- That table can be deleted from (L-02 below), so the one thing that could have removed such a row was checked too: no integration test has ever called this route, so no teardown erased one.
- The only super_admin with a Supabase login is the root admin. Every account this route creates gets one.

So the route never completed in production, no password was emailed by it, and none needs rotating. The first draft cited an empty `email_queue`, which proved nothing: that table only ever held emails SendGrid refused, so a successful send never left a row in it.

**Fix,** the same treatment as H2:
- **No password is taken or set.** The route refuses a `password` field with 400 `PASSWORD_NOT_ACCEPTED`, rather than ignoring it, so a caller cannot believe it set one. The Supabase Auth account is created with no password, and the local `password_hash` is empty, as for a principal at onboarding.
- **The address is typed twice** (`email_confirmation`, case- and space-insensitive): it is the account's only key. The web form's second box refuses pasting.
- **The welcome email carries no credential:** the account exists, its login address, and how to set a password with Forgot password (`platformAdminWelcomeBody`).
- **The response says whether it went** (`welcome_email: 'sent' | 'not_sent'`), and so does the screen. A refused send is not counted as sent; it logs `welcome_email_failed`, which raises `welcome_email_not_sent`.

### L-01 — "Resend welcome" sent a recovery link that could not work ✅ Remediated

- `POST /admins/:id/resend-welcome` minted a Supabase recovery link with no `redirectTo`. Such a link lands on the Site URL, the home page, where nothing reads the token: the same failure as a reset sent from the Supabase dashboard (CLAUDE.md, Auth).
- Its email also said the link lasted 24 hours.
- It now sends the same no-credential welcome as creation, and makes no link at all.

**Tests:** `platformAdminWelcome.db.test.ts` (new, 5):
- creating an admin calls Supabase with no password, stores an empty hash, and sends one email that names the login address and `/forgot-password`, with no password line and no link;
- a `password` field is refused and nothing is created;
- mismatched addresses are refused and nothing is created;
- a send SendGrid refused answers `not_sent`;
- resend sends the same no-credential email and calls `generateLink` not at all.

All 5 fail on the previous route.

### L-02 — `platform_audit_logs` can be deleted from, and test teardown did 🟡 Open (decision for Moses)

**Found** checking the reviewer's question: production has four anonymised platform admins but one `PLATFORM_ADMIN_DELETED` row. Can the delete path skip its audit row?

**The route cannot.** `DELETE /admins/:id` inserts `PLATFORM_ADMIN_DELETED` before it anonymises the account, and has since it was written (`a8506c0`, 19 Jun 2026). If the insert fails, nothing is anonymised. The one row that exists is the root admin deleting a leftover fixture (`e48f826d`) on 1 Oct.

**The missing three were deleted afterwards.**
- They come from a run of the admin-deletion tests against production at 09:19 UTC on 7 Aug, 38 minutes before those tests were committed (`5d8e534`).
- That suite's teardown deletes every `platform_audit_logs` row naming its admins as actor or target. It does so today (`tests/superAdmin.test.ts`), and seven integration files delete from the table: `impersonation`, `onboardingWizard`, `phase4Integration`, `platformAuth`, `schoolSuspension`, `subscriptionExpiry` and `superAdmin` (counted by the reviewer; the first draft said nine).
- Why the user rows outlived their audit rows that morning is not in git: the run used an uncommitted working copy.

**The gap.** Migrations 036–038 protect `audit_logs`; nothing protects `platform_audit_logs`, the record of every platform-admin action, deletions and data wipes included. Any DELETE succeeds, and test code issued them for months. Doctrine 6's accident-proofing does not cover it.

**Decided 2 Oct 2026: protect it, in three commits, in this order,** queued behind the email banner. Nothing deletes these rows in production today.
1. The seven teardowns guard around their audit rows, as the `audit_logs` teardowns already do. Never a session flag or role that lets tests delete (CLAUDE.md: that turns the invariant into a convention).
2. A purge path for a school's platform rows, equivalent to migration 048, so `delete-school-data.js` can still reach zero.
3. Only then the append-only migration. Done first, it would break all seven suites the same day.

### L-03 — The trial gate signed its changes with an arbitrary super_admin ✅ Remediated

**Files:** `migrations/053_system_actor.sql` (new), `apps/api/src/config/systemActor.ts` (new), `apps/api/src/services/subscriptionService.ts`, `apps/api/src/routes/superAdmin.ts` (`/admins` routes), `apps/api/src/config/alerts.ts`, `apps/web/app/super-admin/admins/page.tsx`, and the two test fixtures (`__db_tests__/helpers.ts`, `jest.globalSetup.ts`).

- `runTrialExpiryCheck` records each change it makes (grace, read-only, healing a paid plan) in `platform_audit_logs`, attributed to `SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`.
- That query has no ORDER BY and no `is_active` filter, so it returns whichever super_admin Postgres finds first, fixtures and deactivated accounts included.
- **Observed:** Chronix High School's 8 Sep 2026 auto-suspend is recorded as done by `e48f826d`, a test fixture that the root admin deleted on 1 Oct.
- The record answers "who did this?" with "whichever row came first" (doctrine 8). No admin did it; the system did.

**Fix: a system account, decided 2 Oct 2026.** A NULL or a magic string in `platform_admin_id` would make every reader handle a special case. A real row answers "who did this" honestly.
- **The account.** Migration 053 creates it with a fixed id, `system@chronixedu.internal`, role `super_admin`, inactive, an empty password hash and no Supabase identity. The gate looks it up by that id (`SYSTEM_ACTOR_ID`), never by role.
- **It cannot act as an admin.** Every `role = 'super_admin'` query was audited before building:
  - Login looks the local row up by the Supabase user's id, and it has no identity, so it cannot sign in or hold a token.
  - Everything that grants a super_admin row anything requires `is_active`: the last-admin guard, the purge function's operator (048) and the deletion script's operator.
  - School, announcement, message and dashboard queries are scoped by school, id or the principal role. A row with no school never appears in them.
  - Impersonation needs a school and refuses `super_admin` targets.
- **Kept inactive by the database.** A CHECK (`users_system_account_never_active`) refuses `is_active = true` for that id, whatever a future route or script does. This is the durable half.
- **The admin routes.** The audit found one exposure. Reactivate would have flipped it active, giving an admin nobody can use that the last-admin guard would then count. Delete would have anonymised the name on every change it signed. `GET /admins` now lists it, marked `is_system`, so the name on the audit screen is explicable. The screen gives it no actions, and resend, suspend, reactivate and delete answer 404 `SYSTEM_ACCOUNT` whatever the screen does.
- **A missing account alarms.** The gate looks it up on every run, before it knows whether it has work. Without the account it changes nothing and logs `trial_expiry_system_actor_missing`, which alerts as `system_actor_missing`. It used to check only on a day with work, so in a quiet week a missing row would have looked like a gate with nothing to do (doctrine 9).
- **Both test fixtures recreate it.** The DB suite's seed truncates `users`, and the integration fixture seeds into whatever that left, so each puts the account back. `systemActor.test.ts` checks both, and the migration, against the constant.
- **History is not rewritten.** The 8 Sep record stays attributed to `e48f826d`.

**Tests:** `systemActor.db.test.ts` (new, 4):
- the gate signs with the system account after the old query is shown picking another admin;
- a missing account fails a run with no work and a run with work, logging the event both times, with the trial unmoved and nothing signed;
- the database refuses to activate it, after the same statement activates an ordinary admin;
- the list marks it, and the four routes refuse it with the row, the audit log, email and Supabase all untouched, after the same routes work on an ordinary admin.

All 4 fail on the previous code. `systemActor.test.ts` (unit, 4) also fails the build if any code again selects `role = 'super_admin' … LIMIT 1`.

---

## Round 29 — 2026-10-01

### M-01 — Staff and parent welcome emails carried a working password in plain text ✅ Remediated

**Files:** `apps/api/src/services/welcomeEmail.ts`, `apps/api/src/routes/students.ts` (register, bulk-import preview and commit, add parent), `apps/api/src/routes/users.ts` (staff bulk-import preview and commit), and the screens `apps/web/app/(dashboard)/registrar/students/page.tsx`, `[id]/page.tsx`, `import/page.tsx` and `settings/users/import/page.tsx`.

**The risk.** `welcomeEmailBody` wrote `Password: <temporary password>` into every welcome email for a new parent (registering a student, adding a parent, a student bulk import) and for every new staff member in a staff bulk import. A mistyped address handed a working login to whoever owns that mailbox, with no further step. The mail also persisted wherever it went: the mailbox, SendGrid, and `email_queue` (L-02).

**Decided by the owner, option (iii):** the email carries no credential at all, neither a password nor a link. It says the account is ready, names the login address, and gives the Forgot password steps. Nothing in it signs anyone in or expires. A one-hour link would be dead for most bulk recipients, and the link expiry is global in Supabase.

**What (iii) does not do** is protect a mistyped address: whoever reads the mail can use Forgot password as easily as a link. That protection is an address check before anything is created:
1. **Single parent: typed twice.** Registering a student with parents, and adding a parent, require `email_confirmation` equal to `email`, ignoring case and surrounding spaces. A mismatch is a 400 and creates nothing. The second box refuses pasting. This catches typos, not a wrong-but-valid address.
2. **Bulk: shown, then confirmed.**
   - Both previews return `mailed_addresses`, the addresses the commit will create and mail. It covers valid rows only and counts each address once. A parent who already has an account is linked, not mailed.
   - Both screens list them with a required tick.
   - Both commits refuse without `mailed_addresses_confirmed: true` (`MAILED_ADDRESSES_NOT_CONFIRMED`; never defaulted, doctrine 8), before creating anything.
   - The `STUDENTS_BULK_IMPORT` and `STAFF_BULK_IMPORT` audit rows record the confirmation and the addresses mailed.
   - Like Round 27's read-back, the tick is the operator's statement: it records what they said, and verifies nothing.

**Honest outcome.**
- The emails ran fire-and-forget after the response. They are now awaited.
- Each response states `welcome_email` (or `welcome_emails` for bulk): `sent | partly_sent | not_sent | none`, with the addresses that did not go.
- The screens say "NOT sent to …" and point to Forgot password.
- Anything not sent raises Round 28's `welcome_email_not_sent` alert, with counts only.

**Unchanged on purpose (scope).**
- The registrar's screens still show students' and parents' temporary passwords, and the bulk-import results sheet keeps its "Temporary Password" column.
- A student without an email gets an `@students.internal` address, which delivers nowhere, and there is no student welcome email. For students, the screen and the sheet are the only channel.
- Staff created by bulk import now have a temporary password nobody has seen. They set their own with Forgot password, which clears `must_change_password`.

### L-01 — "Sent" was reported for email that did not go ✅ Remediated

**Files:** `apps/api/src/services/emailService.ts`, `apps/api/src/routes/superAdmin.ts` (onboarding `/complete`), `apps/api/src/config/alerts.ts`.

**The defect.**
- `sendEmail` never throws. A SendGrid refusal is logged and written to `email_queue` for retry; a failed queue write is logged and dropped.
- It returned nothing in every case, so a caller could only count "no error" as sent. Round 27's onboarding message ("The principal has been emailed a link") did, and so did H2's first draft.
- For the same reason, Round 28's `welcome_email_failed` at the send stage could never fire.

**The fix.**
- `sendEmail` now returns `'sent' | 'queued' | 'lost' | 'disabled'`, and only `'sent'` means the email went.
- When SendGrid refuses the onboarding email, `/complete` now says NOT sent, gives the reason, and logs `welcome_email_failed`.
- The other callers ignore the value and are unchanged.

### L-02 — `email_queue` kept every refused email for good, including 1,954 welcome emails with a password ✅ Remediated

**Files:** `apps/api/src/services/emailQueueService.ts`, `apps/api/src/db/queries/emailQueue.ts`, `apps/api/src/db/queries/schoolExport.ts`, `apps/api/src/config/alerts.ts`.

**Measured** in production, counts only, and checked row for row by the reviewer:
- The queue held 1,993 rows, the oldest 104 days old.
- 1,954 had a `Password:` line in the body: 1,851 `failed` and 103 `sent`, dated 19 Jun – 17 Sep 2026. Each was to a different address: 1,761 `test.com`, 191 `example.com`, 2 `gmail.com`.
- **Two real Gmail addresses, not one.** The first draft of this finding named one.
  - `jo****@gmail.com` (8 Aug) is the Chronix High School principal. The queued email predates the current account by a day, and the password has since been changed, so it is dead.
  - `te****@gmail.com` (5 Jul) has no account. The credential died with the account. Moses confirmed it is his own test address (2 Oct).
- **The 5 fixture parents could not sign in at all.** This was corrected twice, and both errors had one root:
  - The first draft said their passwords "would still sign in". The reviewer narrowed that to "reaches the change-password screen", because all 5 still had `must_change_password`.
  - Both readings came from `public.users`. Login is Supabase `signInWithPassword`, which resolves against `auth.users`, and neither of us had queried it.
  - None of the 5 has an identity there, by id or by address. Their `users` rows date from 31 Aug, before bulk import created login identities.
  - "One demo school" came from the same habit. Grouping by `DISTINCT s.name` collapsed six schools into one label; the 5 sat in three of the six schools named "Bulk Import Commit Test School".
  - The root, in the reviewer's words: concluding from the table at hand rather than the one that governs the behaviour.
  - It is wider than the 5. Production holds 239 `users` rows and 7 Auth identities, so 232 accounts cannot authenticate at all. The four remaining "Bulk Import Commit Test School" schools hold 121 users, and none of them has an identity (`docs/AUDIT-2026-09.md`, L-test-data).
- So no working credential was exposed. The table is readable only with the service role or as the table owner.

**The mechanism.**
- **Nothing ever deleted a queued email.**
- **Most rows could no longer be reached.** `email_queue`'s only link to a school is `to_email` → `users.email`. 1,958 of the 1,993 rows had no surviving user, so no school deletion could ever reach them.
- **The deletion script is not at fault.** It deletes `email_queue` (step 6) before `users` (step 11), as it must. The orphans are left over from the old demo seeder's raw deletes and from test teardown.
- **The export said otherwise.** `schoolExport.ts` described the table as "transient", which was not true.

**Fix.**
- **A retention rule.** A daily job (`email-queue-retention`, 03:15 Lagos, through `runExclusive`) deletes every queued email older than `EMAIL_QUEUE_RETENTION_DAYS` (7 days), whatever its status.
  - **Why 7 days:** the retry job is done with a row within about 2½ hours (5 attempts, 30 minutes apart). A week leaves time to read `last_error` when someone asks why an email never arrived. After that, SendGrid's activity log is the record.
  - **Pending rows go too.** A row still `pending` after a week is deleted, with a warning (`email_queue_retention_dropped_pending`). The retry job has not run it for a week, and keeping it would rebuild the store. This deliberately goes further than the reviewer's "sent and terminally failed".
  - **A failed run raises `cron_failed`** (`email_queue_retention_cron_error`).
  - **The export reason is true now:** `schoolExport.ts` says the table is transient and each row is deleted after 7 days.
- **The rows, deleted 2 Oct 2026**, as Moses approved.
  - **The rehearsal came first** (`docs/data-deletion-runbook.md`, "Rehearsal"). Two of the three demo schools holding the 5 were deleted with `delete-school-data.js`, queued mail included. The session's safety check refused the third, which is left for Moses.
  - **Then the job's own statement, run once:** it deleted 1,887 `failed` and 103 `sent` rows, 1,990 in all. The other 3 went with the two schools.
  - **The queue is now empty**, and no row mentions a password. Re-checked by the reviewer later on 2 Oct: 0 rows. The job's first scheduled run comes after this; the 1,990 went when its statement was run once by hand.

**Tests:** `emailQueueRetention.db.test.ts` (new, 3 tests):
- Six rows are shown present first. The run deletes the three older than a week (`sent`, `failed`, and a 104-day `failed`) and keeps the three recent ones, whatever their status.
- A week-old `pending` row is deleted and named in a warning, while a recent one stays.
- The job is registered at `15 3 * * *`.

All three fail on the pre-change code.

### I-01 — "Use Forgot password" relied on an Auth identity that nothing checked ✅ Guarded

**Raised by the reviewer**, who checked the obvious worry first. H2's email tells a bulk-imported parent to use Forgot password: does that parent have a login? Yes. Every path that sends the email creates the Supabase Auth identity first: `createAuthAccountFor` inside `registerStudent`, and `createUser` in add-parent and staff bulk import. So there was no defect.

**The coupling was load-bearing and unrecorded.** A future path could create a `users` row without an identity and still send the email:
- The person would be told to reset a password that does not exist.
- Forgot password answers the same 200 for every address (Round 24), so they would get a success message and no email, every time.
- Nothing would log it, because nothing failed. Round 28's silent-catch ratchet cannot see it either: there is no error to swallow.

**The guard.** `sendWelcomeEmails` asks Supabase Auth whether each recipient has an identity with its id and its address.
- It uses `getUserById` through the admin API, because the C-4a app role cannot read `auth.users`.
- A recipient without an identity is not mailed, is named in `not_sent`, and raises a new alert, `account_cannot_sign_in`, with counts only.
- If the check itself cannot complete, nothing is sent either, and `welcome_email_failed` is logged at stage `verify`.
- Each recipient now carries its `userId`, and `registerStudent` returns the new parents' ids for it.

**Tests:**
- `welcomeEmailNoCredential.db.test.ts`: add-parent where the account is created without an identity. It answers 201, the account exists, `welcome_email` is `'not_sent'`, no email goes, and exactly one `welcome_email_no_login` is logged. The neighbouring test, with an identity, sends: that is the control.
- `welcomeEmailOutcome.test.ts` (3 new): no identity; an identity holding a different address; the check failing. The "all sent" test now also asserts that each login was checked.
- All five fail against the pre-change welcome service.

**Tests (M-01, L-01):**
- `welcomeEmailNoCredential.db.test.ts` (new, 12 tests).
  - Covers all four routes. In each, the matching or confirmed request succeeds first.
  - What its email must not contain: the password Auth was given (the mock records it), or any link. What it must contain: a pointer to `/forgot-password`.
  - Then each bad request is refused and creates no account, makes no Auth call and sends no email: a mismatched address, a missing confirmation, `false`, and the string `"true"`.
  - The preview's `mailed_addresses` equals what the commit mails and what the audit row records. Siblings count once; an existing parent and an invalid row are excluded.
  - Linking an existing parent answers `none`. With email unconfigured, the answer is `not_sent`, with a warning.
  - SendGrid refusing one of two answers `partly_sent`, names that address, and raises the alert with no address in it.
- `welcomeEmailOutcome.test.ts` (new, unit, 10 tests):
  - `sendEmail`'s four outcomes;
  - `sendWelcomeEmails` when all are sent, one is refused, preparation fails, email is unconfigured, and there is nobody to send to;
  - the body.
- `onboardingFiveSteps.db.test.ts` (1 new test): SendGrid refusing the principal's email answers NOT sent, with the reason.
- `tests/staffBulkImport.test.ts` used to read the password out of the email to prove it worked; it now asserts the email has none. Both the local and the CI integration runs exclude this suite (it needs real Supabase Auth), so the DB suite above is the one that runs.

**Run against the pre-change code:**
- The first 11 DB tests all fail. The twelfth, for a partial refusal, was written after that run.
- All 10 unit tests fail.
- The new onboarding test fails, while its 11 neighbours pass.

---

## Round 28 — 2026-10-01

### L-01 — Failures caught and dropped, so no log line or alert could ever show them ✅ Remediated

**Found** answering a reviewer's question about step 2's alert list. That list, and its ratchet, see only failures that are *logged*. A scan for handlers that ignore the error (`.catch(() => {})`, `=> undefined`, `=> null`) and empty `catch {}` blocks found these, each now logging a named event:

| Where | What was dropped | Now |
|---|---|---|
| `routes/students.ts`, bulk promotion | its audit write (`logAudit(...).catch(() => {})`), awaited and then thrown away, against doctrine 10 | `audit_write_failed` (alerted) |
| `middleware/detectSupportSession.ts` | the support-token blacklist read: a bare `redis.get` in a silent catch, so with Redis down a revoked support token was accepted and nothing said the check was skipped | through `bestEffort('token_blacklist_unavailable')`: still fails open, now logged and alerted |
| `routes/superAdmin.ts`, platform-admin deletion | a failed Supabase Auth delete: the local lockout still blocks login, but the deleted admin's identity, password and all, stayed behind | `platform_admin_auth_delete_failed`, new alert `auth_account_left_behind` |
| `routes/announcements.ts`, `routes/messages.ts` | the whole announcement fan-out, and a message's in-app notification ("non-critical") | `announcement_fanout_failed`, `message_notification_failed` (`notification_lost`) |
| `routes/students.ts` (3), `routes/users.ts` (1) | the blocks that look up the school and send welcome emails: a failure meant no login details, silently | `welcome_email_failed`, new alert `welcome_email_not_sent` |

**Dead but misleading:** six `sendEmail(...).catch(() => {})`. `sendEmail` never rejects (it logs `sendgrid_email_failed` itself), so they now log a named event instead of reading as "failure ignored".

**Also:** with email not configured, platform announcements `console.log`ged each recipient's address and the message. They now log `platform_announcement_email_not_sent` with the announcement id only.

**Ratchet:** `alerts.test.ts` fails on any such handler in `src` unless it carries `// silent-ok: <reason>`. Three do: two ROLLBACKs whose original error is rethrown or answered, and the alert sender's own catch. Comments are stripped before matching, on CRLF files too. That was the first draft's bug: two comment lines matched because a trailing `\r` defeated the strip. A control runs the scanner on a known sample, in both line endings.

**Tests:**
- `detectSupportSession.test.ts` (new): a revoked token is refused while Redis answers (the control); with Redis down the session passes **and** `token_blacklist_unavailable` is logged; healthy, nothing is logged. On the pre-change middleware, the second fails.
- Mutation: an unmarked `.catch(() => {})` added to a service fails the ratchet, naming the file and line.

**Not changed:** the welcome emails these blocks send still carry a temporary password (working checklist item H2).

---

## Round 27 — 2026-10-01

### M-01 — A mistyped principal address hands the principal account to whoever owns that mailbox ✅ Remediated

**Files:** `apps/api/src/routes/superAdmin.ts` (onboarding step 4 and `/complete`), `apps/api/src/config/appUrls.ts` (new), `apps/api/src/routes/auth.ts`, `apps/web/app/super-admin/onboard/page.tsx`, `apps/web/lib/superAdminApi.ts`.

**The risk, stated correctly.** The principal's email address is the account's only key: "Forgot password" sends the reset link to it. A typo that lands on someone else's real mailbox therefore lets that person take over the principal account of a real school. They receive the welcome email, then reset the password. Child Prime's re-onboarding runs through this path.

**Correction.** This was first raised (1 Oct, working checklist item H) as "the welcome email carries the temporary password in plain text". It did not. Since Round 5 (`3a0c63d`, 9 Jul 2026) the password was never stored or emailed. Step 4 returned it to the operator's screen, to be passed on by hand, and the email said to ask the administrator. The takeover needed one more step (Forgot password), and the risk was real all the same. The same correction applies to the note that the no-SendGrid `console.log` printed a password: it printed the email body, which held none.

**Fix, three parts, decided by the owner** (option (c)):
1. **Typed twice.** Step 4 requires `email_confirmation` equal to `email`, ignoring case and surrounding spaces; on a mismatch it refuses with a field error and creates nothing. The second box refuses pasting. This catches typos, not a wrong-but-valid address.
2. **A link, not a password.** The Auth account is created with no password, and step 4 returns none. `/complete` makes a Supabase recovery link (`generateLink`, redirect shared with forgot-password through `resetPasswordRedirect()`) **before** activating anything, and emails it. If the link cannot be made, it answers 502 and nothing is activated.
   - What this changes: no one relays a password, and a wrong address is visible at once, because the real principal never receives the link and says so. Before, they logged in quietly under the mistyped address with the password the operator read out.
   - What it does not change: a misdelivered link is still a takeover.
3. **Read back by phone, recorded.** `/complete` requires `principal_email_read_back: true` (never defaulted; `PRINCIPAL_EMAIL_NOT_READ_BACK` otherwise), checked after the wizard's own refusals (missing steps, no principal) so it never masks them. The wizard's Review step asks for it with the address in full. Each completion writes `PRINCIPAL_EMAIL_READ_BACK_CONFIRMED` to `platform_audit_logs`: operator, address, time, `asserted_confirmed: true`.
   - It is the operator's statement, and the system cannot check it. It prevents nothing and records everything, which is all an audit row is for (doctrine 6).
   - It is still the only part that closes misdelivery. If the three are ever trimmed, keep this one.

**Also:**
- The no-SendGrid branch `console.log`ged the whole email. It now carries a working link, so it logs `onboarding_welcome_email_not_sent` with the school id only.
- The response said "Welcome email sent" even when none was; it now returns `welcome_email: 'sent' | 'not_sent'` and says which.
- `onboarding_set_password_link_failed` is classified in `NOT_ALERTED`, because the operator is on screen when it happens.

**Tests** (`onboardingFiveSteps.db.test.ts`, six new):
- a mismatched confirmation is refused and creates nothing, while a matching one creates the principal;
- the account is created without a password and the response carries none;
- `/complete` without the read-back, or with it false, is refused and activates nothing; with it, one audit row names the operator and address;
- the email goes to the confirmed address with the link and no "temporary password";
- with email not configured, the response says not sent and nothing is printed;
- if the link cannot be made, nothing is activated and the session stays in progress.

Run against the pre-change route, all six fail and the suite's five older tests pass.

**Not changed, recorded:** parent and student accounts made by the registrar still show temporary passwords on screen (`registrar/students`). That is the same pattern for other roles, and it is a separate item.

---

## Round 26 — 2026-10-01

### L-01 — Local integration runs sent real email through production SendGrid ✅ Remediated

**Files:** `apps/api/jest.globalSetup.ts`, `apps/api/tests/noOutsideWorldKeys.test.ts` (new).

The integration setup loads `apps/api/.env`, which holds production's `SENDGRID_API_KEY`, `TERMII_API_KEY` and `PAYSTACK_SECRET_KEY`. Most suites also call `dotenv.config` themselves. The setup already refused a remote database and a remote Supabase, but nothing stopped a local run from using the real providers. A throwaway test printing only yes/no showed `isEmailConfigured()` was **true** inside a normal local run. CI was never affected: it has no `.env` and sets no provider key.

**Measured, not inferred** (two full runs, with every provider key present but nothing able to leave the machine):
- **Email:** SendGrid's client was replaced by a recorder. One message per run: the platform-announcement publish test mailing a fixture principal at a bare `@test` address, which cannot be delivered. So each local run spent one email of the production account's allowance and produced one bounce. Before measuring, this was described as mail to `@test.com` principals; that came from a fixture whose test stubs email, and was wrong.
- **Everything else:** every `fetch` to a non-local host was recorded and answered locally. There were **zero**, with Paystack and Termii keys present and SMS switched on. A control call to `api.paystack.co` from a throwaway test was caught, so the zero is real. Paystack and Termii are stubbed by the suites that reach them.

**Fix:** after loading `.env`, the setup **empties** `SENDGRID_API_KEY`, `TERMII_API_KEY`, `PAYSTACK_SECRET_KEY`, `SMS_ENABLED` and `SENTRY_DSN`, and sets a marker. Emptied rather than deleted, because dotenv never overwrites a variable that is set, so the suites' own `dotenv.config` calls cannot bring the keys back. A test that needs a provider sets a fake key and stubs the call, as `feesPayout` and `payoutSettings` already did.

**Tests:** `noOutsideWorldKeys.test.ts` loads `.env` the way most suites do, then asserts:
- the marker, which is the control, because a machine without a `.env` passes the rest whatever the setup did;
- each key empty;
- email and SMS off.

On failure it reports a key as "HAS A VALUE", never its value. A failing run on a developer machine would otherwise print production keys; the mutation run's output was checked for SendGrid-shaped strings and held none. With the emptying removed, the test fails on a machine whose `.env` holds the keys.

After the fix, a full local run with nothing blanked in the shell: 22 suites, 187 passed, 7 skipped, and the recorder caught **0** emails, down from 1.

---

## Round 25 — 2026-10-01

### M-01 — The brute-force controls could be off with nothing raising an alarm ✅ Remediated (owner check open)

**Files:** `apps/api/src/config/alerts.ts` (new), `config/logger.ts`, `middleware/rateLimit.ts` (comment), `index.ts`.

Round 19 made Redis best-effort. While Redis is down, both brute-force controls are off: the per-address limiter and the per-email lockout. So are the token blacklist and the caches. That was logged at `error`, and nothing read it. More generally, the API sent Sentry only unhandled exceptions, so every condition it logs and carries on from was invisible. That included mail failing, a notification lost, an audit write failing, and the payout-change fraud alert not going out.

**Fix:** `config/alerts.ts` is an allow-list of 12 named alerts covering 38 log events. A winston format sends a listed event to Sentry, and nothing else:
- level `error`;
- once per 15 minutes per process, with a count of what was held back;
- grouped by alert name and environment;
- carrying **only the fields named for that alert**, with error objects reduced to their message.

The other 15 events are in `NOT_ALERTED`, each with its reason. `alerts.test.ts` is a ratchet over the source. It fails on an error event in neither list, on a listed name that no longer occurs in the code (so a rename cannot silence an alert), and on a computed event name outside `bestEffort`.

**Sentry stays technical-only (DPA).** A whole log line never goes, because log lines carry addresses: `sendgrid_email_failed` logs `to` and `subject`. A test sends that event with an address and a pupil's name in it, asserts the alert was sent, and asserts neither value is anywhere in what Sentry received.

**Proven end to end:**
- The API ran locally for 25 s with `REDIS_URL` at a dead port, every outside-world key blank, and Sentry environment `development`.
- It logged 31 Redis failures and produced **one** event: issue `CHRONIXEDU-API-1`, the API project's first. Its context held the event name, `Command timed out`, the rate limiter's detail and the held-back count. The rest is the SDK's standard runtime context (host name, OS, memory).
- The project's rule "Send a notification for high priority issues" (6094724) emails the issue owners, falling back to active members. It **fired 27 s later**.
- That measurement is why every alert is `error`: a warning is not guaranteed to be rated high priority, and could make an issue that emails nobody.
- It is also why grouping includes the environment: the first version grouped by name alone, so a real production outage would have joined this test issue and raised nothing new.

**Mutation checks:**
- With the format removed from the logger, the four tests that log through the real logger fail. The "unlisted event is not sent" test passes either way, which is why the control sits beside it.
- With an unclassified `logger.error` event added to a service, the ratchet fails and names it.

**Owner check, closed 1 Oct 2026:** both alert emails arrived, with event ids matching Sentry's: `a42dde73…` (API-1, development) and `c337e910…` (API-2, below). They go to the Chronix Zoho mailbox, not a personal one. Both issues are resolved.

**Follow-up, the first production event (CHRONIXEDU-API-2, 16:28:09 UTC, release `8303c04`), was a start-up race, not an outage.**
- 1.77 s after the process started, all three rate limiters' Redis stores failed to load their Lua scripts ("Command timed out"). The stores are built at boot, before the Redis client has connected, and the 500 ms command timeout expired first.
- No limit was lost: `rate-limit-redis` 5.0.0 reloads its script on the first request (`retryableIncrement`), and there was no `redis_client_error`.
- It happened on 1 of 32 API boots since 30 Sep. Every fix is a deploy and every deploy a restart, so it would have kept raising "rate limits are OFF" falsely. An alarm that cries wolf in its first week stops being read.
- **Fix:** the limiters' transport (`redisTransport` in `middleware/rateLimit.ts`) makes a `SCRIPT LOAD` wait for the client's first `ready`, bounded at 10 s. Nothing else waits, and nothing waits after that first `ready`, so a Redis that dies later still fails within 500 ms (Round 19). A Redis that never connects at boot is still reported once the bound passes.
- **Tests** (`rateLimitRedis.test.ts`, a client that starts "connecting" and fails commands like ioredis's timeout):
  - the old transport reproduces the start-up error (the control);
  - the new one logs none, and the limit bites from the first request;
  - after boot a dead Redis fails at once (a wait would exceed Jest's timeout);
  - a Redis that never connects is reported.
- With the gate removed, the second test fails.

---

## Round 24 — 2026-10-01

### M-01 — `/forgot-password` revealed which accounts exist ✅ Remediated

**File:** `apps/api/src/routes/auth.ts`, `handleForgotPassword` (served at `POST /api/auth/forgot-password` and `/reset-password`).

The handler looked the address up, and only for a known address asked Supabase to send the reset email, awaiting it. So:
- **Unknown address:** 200 with the generic message.
- **Known address, send failed:** 500 `RESET_EMAIL_FAILED` carrying Supabase's own error text.
- **Known address, send threw** (network): 500 through the error handler.
- **Known address, send succeeded:** 200, but only after the Supabase round trip.

Anyone could therefore test any address for an account: by status whenever mail was failing, and by response time always. Live production request logs show the size of the timing gap: a known address took 1.4–1.8 s.

Rounds 17 and 19 state that forgot-password "answers 200 whether or not the account exists". That was true only while the send succeeded.

**When the status oracle was open:** whenever Supabase Auth could not send. On 1 Oct 2026 that was from at least 08:40 UTC (451 "Maximum credits exceeded" on `POST /recover`) until the switch to SendGrid SMTP (first 200 at 10:17:38). Railway's request logs for the API, which reach back at least to 29 Sep, hold four POSTs to this route. All four came from one address and one browser at 08:40, 08:57, 10:09 (500 each) and 10:17 (200), consistent with the owner's own reset tests. There is no sign anyone probed it. That covers the retained window only.

**Fix:**
- Every well-formed request gets the same 200 and the same body, and gets it **before** any email is attempted. The known branch then sends in the background (`sendResetEmail`).
- A returned or thrown failure is logged as `password_reset_email_failed` with the user id and Supabase's message. A success is logged as `password_reset_email_accepted`. The address is never logged.
- Validation (400) and the redirect allow-list (400 `INVALID_REDIRECT`) answer before the lookup and are the same for every address, so they were never part of the oracle.

**Timing, decided:** both branches now do exactly one indexed lookup and answer. Nothing is padded or made constant-time. The remaining difference is the Supabase call running after the response, which is not observable in the response. A fixed minimum delay was rejected: it leaks again whenever Supabase is slower than the floor.

**Cost, accepted:** a person whose reset email fails is told "If an account exists for that email, a password reset link has been sent", the same as everyone else, and gets nothing. Before, they saw Supabase's raw error. The failure is now in the server log by user id, and whether it should page someone is work order step 2 (deliberate Sentry capture).

**Tests:** four in `src/__tests__/auth.test.ts`:
- a control: the known address really is sent a reset, and the unknown one is not;
- a known address whose send **returns** an error, and one whose send **throws**, each asserted to get the same status and body as an unknown address, with the failure logged by user id and not by address;
- a known address answered while Supabase has not yet replied.

Run against the pre-fix route (`git show HEAD:…/auth.ts`, restored by a `trap`), all four fail: two answer 500, the timing test never gets a response, and the control waits for a log line the old code never writes. The other 12 auth tests pass on both.

---

## Round 23 — 2026-10-01

### H-01 — Passwords in a public repository for three and a half months ⚠️ Partially remediated

**File:** `apps/api/scripts/seed-child-prime.js` (16 Jun – 1 Oct 2026), in the **public** repository `iiamkingjosh/chronixedu`.

The demo seeder hardcoded two password constants: one for the platform super-admin account `info@chronixtechnology.com`, and one shared by every Child Prime staff account. It also deleted every school and every Supabase Auth user with no dry run, no host check and no confirmation.

**Done, 1 Oct 2026:**
- The file was deleted in its own commit (`1254ac9`).
- **The file was removed from git history** with `git-filter-repo --invert-paths`, in a fresh mirror clone, and force-pushed (`28600d6` → `a799c9a`). The push used `--force-with-lease` pinned to the expected old commit, so it could not overwrite anything newer.
- Verification:
  - The new `main` has the **same file tree** (`a461a7a`) as before, so the code and docs are byte-identical and only history changed.
  - Both password literals occur in **0** blobs in the rewritten repository. The same scan run against the original found them, so the zero is real.
  - No commit touches the path.
  - One commit (`83b7ae2`, a rename inside the seed script) became empty and was dropped: 307 commits, previously 308.
- **Scope check across all history:** no other secret was ever committed. No `.env` file, and no Paystack, SendGrid, Supabase or JWT keys, private keys, or database URLs with real passwords. The only database URLs are the local test container's `postgres:postgres@localhost`; Termii-shaped hits are `package-lock.json` integrity hashes.
- GitHub reported the repository public, with 0 forks and no pull-request refs, so nothing else on GitHub pins the old history.

**Open, owner actions:**
1. **Rotate both passwords.** This is the real fix, and it is not confirmed done. Removal from history does not un-leak a secret: anyone who cloned, forked or browsed the repository before 1 Oct may hold it. The super-admin account is the one that matters. It can see every school, start support sessions and record payments. Enabling MFA on super-admin accounts would bound the next leak.
2. **Ask GitHub Support to purge cached views.** After the force-push, GitHub still served the old commit `97739d7` and the raw file by direct link (HTTP 200). That is documented GitHub behaviour for orphaned commits until its own clean-up or a Support request ("Remove sensitive data") removes them. Only the account owner can file it. Give them the repository name and the old commit IDs `97739d7` and `28600d6`.
3. Local copies remain on the development machine: a recovery bundle in the session's temp folder, and two stale agent worktrees under `.claude/worktrees/` checked out at old commits. They are not public. Delete them once the rotation is confirmed.

**Consequence of the rewrite: commit IDs changed.** Every commit since 16 Jun 2026 has a new ID. Docs and code comments were updated (40 references). Three places still show the old IDs, as history:
- Railway's deployment list;
- GitHub Actions runs;
- `migration_runs.commit_sha` rows.

`migrations/049` quotes one old ID in a comment and is deliberately not edited, because it is an applied migration. The IDs those places mention:

| Before the rewrite | After |
|---|---|
| `e0eb457` | `aead53b` |
| `86b0a18` | `3abbabe` |
| `3a4d1e7` | `9e2e404` |
| `c07c0b4` | `c671c5f` |
| `13c1157` | `d46299f` |
| `d5c7716` | `7e99984` |
| `fe222d2` | `5b81d9a` |
| `c39e937` | `752db72` |
| `00f39f2` | `4c5e5d6` |
| `cbd8359` | `184ed7b` |
| `58eca29` | `e7a1a25` |
| `93b5938` | `f7b834e` |
| `98b8e5d` | `a764c80` |
| `033e194` | `fccb98b` |
| `4c29f4d` | `84fd1b8` |
| `b15b7c8` | `21b0135` |
| `b1eb76a` | `1254ac9` |
| `28600d6` | `a799c9a` |

---

## Round 22 — 2026-10-01

**Scope:** Option (a) of the deletion runbook, decided by Moses 1 Oct 2026: one school's audit rows may be deleted, through a named purge path and nothing else, so a school deletion can end at zero rows.

### I-01 — A door through `audit_logs_no_delete`, built so it is the only one ✅ Built

**Files:** `migrations/048_audit_purge_path.sql` (new), `apps/api/scripts/delete-school-data.js`; tests `schoolDeletion.db.test.ts`, `purgeDuringNotification.db.test.ts` (new)

Relaxing an append-only guard is the change most likely to relax more than intended. 036 once banned UPDATE alongside DELETE with only DELETE checked, and silenced every parent notification. So the header of 048 enumerates every operation on both audit tables, before and after, and each is tested.

**Mechanism.**
- A `NOLOGIN` role with no members, `chronixedu_audit_purger`, owns a `SECURITY DEFINER` function, `chronixedu_purge.purge_school_audit_logs(school_id, operator_id)`.
- The DELETE trigger passes only when `current_user` is that role, which happens only inside the function.
- **No session flag.** Any caller can set a custom GUC, which would turn the invariant into a convention.

**Exposure, three independent walls:**
- Functions in `public` get EXECUTE for PUBLIC by default, and Supabase exposes `public` over `/rest/v1/rpc` to `anon`. A purge function left with defaults would have been an unauthenticated audit-log wipe.
- The function lives in a schema PostgREST does not expose.
- PUBLIC has no USAGE on that schema.
- EXECUTE is revoked from PUBLIC, `anon`, `authenticated` and `service_role`, and granted only to the table owner.

**Scope.** The function deletes only the given school's rows: its `school_id`, or rows by its users (those users are deleted next and the FK requires it). It refuses a null id, and an operator who is not an active super admin outside the school. It writes its own record to `platform_audit_logs` before deleting. If the count it deleted differs from the count it recorded, it rolls back.

**Unchanged and tested one at a time:**
- a plain DELETE as the owner;
- content UPDATE (037);
- write-once `processed_at`;
- TRUNCATE (still unblocked, doctrine 6).

`platform_audit_logs` was measured to have **no triggers at all**; only its foreign keys kept a school alive.

**Production's role conditions.** Production's `postgres` is not a superuser (CREATEROLE + BYPASSRLS), and locally it is. 048 was therefore also applied as a simulated non-superuser with those attributes, which found a failure a superuser run hides: the purger needed USAGE on its own schema while its grants were being set. That was fixed and re-verified. Ownership changes and the function's grants are made *as* the new owner, because Postgres rewrites an old owner's ACL entries on `ALTER … OWNER`, which would have silently taken EXECUTE away from the table owner.

**Tests.**
- The new tests fail on the old code (11 of 18, plus the worker test), each for the right reason.
- The guard tests pass on the old code by design, so they were shown to bite with a deliberately over-broad 048: all five failed.
- The notification worker is purged *mid-run*, between reading its batch and stamping a row, and completes. A later school's row is still processed.

**Proven in production, 1 Oct 2026.** After the deploy, production showed every property above by direct query. A no-match `DELETE FROM audit_logs WHERE false` was refused with the new HINT. A throwaway school with one user, one logo and audit rows was deleted with `--with-supabase` and verified independently of the script: Auth API 404, Storage API 404, and 0 rows across every uuid/text column of every `public` table, with the scanner controlled on a school that still existed. A real network failure on the first attempt stopped the run with the database untouched, confirmed by query. The stray `guyg ` school was deleted the same way. Runbook, "Live trial (production)".

**Residual, stated.** The table owner still holds ADMIN on the purger role (Postgres grants a role's creator ADMIN option automatically). It could grant itself membership, and it could `DISABLE TRIGGER`. Both are deliberate acts, and the first leaves a `pg_auth_members` row that the test asserts is absent. Doctrine 6: accident-proofing, not tamper-proofing.

### L-01 — The DB suite's rebuild left non-`public` schemas behind ✅ Fixed

**Files:** `apps/api/jest.db.globalSetup.ts`

The rebuild dropped only `public`. 048's `chronixedu_purge` survived between local runs, so a "revert to the old code" run still had a stale purge function: the privilege test passed with 048 removed. A test harness that keeps state between runs can report a guard as working when it is absent. It now drops every schema a migration creates. CI was unaffected, because it starts empty.

---

## Round 21 — 2026-10-01

**Scope:** "Public claims and the retention commitment" (approved 30 Sep 2026): every statement on the public pages about security, data handling and deletion, checked against the code. The legal pages (DPA, Terms) were accepted by schools and were **not** edited; where they and the code disagreed, the code was changed.

### M-01 — Sentry received every signed-in user's email address ✅ Fixed

**Files:** `apps/api/src/middleware/auth.ts`, `apps/web/sentry.client.config.ts`

The DPA names Sentry as a sub-processor for "technical/diagnostic data only". `tagSentry` called `Sentry.setUser({ id, email })` on every authenticated request, so every error event carried the user's email address to a third party outside the stated purpose. **Fix:** id only (an opaque UUID that still traces an error through our own database). Session replay was checked at the same time: SDK 10.58's defaults mask all text and inputs and block media, so replays did not carry screen contents. Those three options are now stated explicitly in the config, so the DPA's claim no longer rests on an upstream default. Events sent before this deploy still carry emails and age out under Sentry's retention (`docs/data-deletion-runbook.md`).

### M-02 — The read-only carve-out's test could not fail on the failure it existed for ✅ Fixed

**Files:** `middleware/requireWritableSubscription.ts`, `__tests__/carveOut.test.ts` (new), `__db_tests__/trialGate.db.test.ts`

Round 20 pinned `READ_ONLY_WRITE_ALLOWLIST` to `[]`. That caught someone widening the list, but not the failure the list exists to prevent: a subscription-payment route added under `/api/schools` and forgotten, so a read-only school is refused the one write that would restore it. The test passed whether or not such a route existed (doctrine 16). **Fix:** a naming contract (`PLATFORM_PAYMENT_PATH`: `platform-billing`, `subscription`, `renew`, `checkout` path segments) and a structural test. It parses `index.ts` for the routers actually mounted behind the guard, walks every non-GET route in them, and fails if one matches the contract and is not carved out. Controls: at least 20 routers and 60 write routes are read, and a known POST is found; a synthetic uncarved checkout route is caught and a carved one is not; no existing route matches (the parent-fee `/payments/paystack/initiate` must not).

### I-01 — A principal could not take their school's data ✅ Built

**Files:** `db/queries/schoolExport.ts` (new), `services/csv.ts` (new), `routes/schools.ts`; web `settings/export`; test `schoolExport.db.test.ts`

The DPA promises "a complete export … (CSV or PDF)". The only export was a super-admin students CSV. **Built:** `GET /:schoolId/export` (counts) and `/export/:dataset` (CSV), 30 datasets. They use this file's `requireSchoolAccess`, which admits principal and super_admin only (a teacher gets 403, tested). Every query is scoped on `$1 = school_id`, and tables without a `school_id` column go through the school's students, terms, configs or assignments. The `people` dataset names its columns, so the password hash is never selected. Each download is audited (`SCHOOL_DATA_EXPORTED`). It is a GET, so it works while read-only (tested next to a refused POST). **Completeness ratchet:** every table in `pg_tables` must be an export source or be named in `NOT_EXPORTED` with a reason. A new table fails the test until someone decides. Every dataset is checked for School B's ids.

### I-02 — Deleting a school: a tested script; the audit log is the open decision

**Files:** `apps/api/scripts/delete-school-data.js` (new), `migrations/047_component_total_skips_deleted_config.sql` (new), `__db_tests__/schoolDeletion.db.test.ts` (new), `docs/data-deletion-runbook.md` (new)

The deletion promise had no process. The script is dry-run by default. It refuses a non-local database unless `--allow-host` names the URL's host, and refuses `--execute` without `--confirm <slug>` and an explicit Supabase choice. It deletes Supabase Auth accounts and Storage files first (stopping, with the database untouched, if any fails), then every table in one transaction. It never prints the service key (verified with a sentinel). Writing its test found that **no school could ever have been deleted**: the component-weight trigger re-checked, at COMMIT, configs the same transaction had deleted. Migration 047 skips configs that no longer exist; emptying or unbalancing a live config is still refused (tested). **Not deleted, by design:** `audit_logs` (append-only since 036/037) and the users and school rows it references. Both routes the spec named, delete or anonymise, need the audit trigger relaxed, because anonymising is an UPDATE. The trade-off is in the runbook, **[MOSES]**.

---

## Round 20 — 2026-09-30

**Scope:** The plan and pricing decisions of 30 Sep 2026 (plans trial / premium / enterprise; ₦800 per student per term), and what they exposed in the gates that depend on the plan.

### M-01 — The feature gate could not refuse anything but one string ✅ Fixed

**Files:** `apps/api/src/services/planFeatures.ts`, `middleware/requireFeature.ts`, `middleware/requireWritableSubscription.ts` (new), `db/queries/schools.ts`, `routes/superAdmin.ts`; tests `planFeatures.test.ts`, `trialGate.db.test.ts`

`planIncludesFeature` was one rule: `false` if the tier was the string `'basic'`, `true` for everything else, including `null`, `trial`, and any value nobody had decided about. Removing Basic — the pricing decision — would have made `requireFeature('analytics')` and the five `requireFeature('online_payments')` call sites decoration, and it had already been failing open **in silence** for trial schools, which is why nobody knew trial had full access.

**Fix.** One plan list (`PLANS`), one zod enum built from it (`planEnum`, now every plan enum in `superAdmin.ts` — the four literal copies are gone and a test fails if one comes back), and a `Record<Plan, PlanFeature[]>` map: a plan added without a feature decision is a **type error**, so the build fails rather than the plan inheriting everything. Trial, premium and enterprise all get every feature — decided, not defaulted. A null or unknown tier still passes (a misconfigured school should not lose what it pays for) but is **logged at error** with the value. A `read_only` subscription has no features whatever its plan.

**The trial gate replaces suspension.** The trial-expiry job used to set `schools.is_active = false`, which answered 403 on every `/api/schools/:id/*` route after staff had signed in successfully: teachers lost attendance, principals results, parents report cards, and nobody could export their own students' records. Now: trial through the end date, 14 days of grace with full access and an in-app countdown, then **read-only** — every GET works, every write under `/api/schools/:id` is refused with 423 `SCHOOL_READ_ONLY`, and the extras are off. It is keyed on the **subscription** status, never on `is_active`, which stays an administrator's deliberate decision with its own route. Super admins bypass. The status rides on the cached school row, so neither guard adds a query per request; every route and the job clear that cache when they change it.

**The payment carve-out is empty, and says so.** Read-only must not block the routes that let a school pay — but no route under `/api/schools` lets a school pay its Chronix subscription yet. `READ_ONLY_WRITE_ALLOWLIST` exists, is pinned empty by a test, and the payment system adds its routes to it one at a time, each tested while read-only. Today's way back is a super-admin payment record, extending the trial, or a PATCH — all outside the guard.

**Tests.** `trialGate.db.test.ts`, 19 tests: 18 fail with the old code restored (old behaviour files from git, migration 046 moved aside, the new guard reduced to a pass-through); the 19th was found passing on the old code for the wrong reason (it omitted a field the old code required), rewritten, and now fails on the old code for the right one. `planFeatures.test.ts` cannot load against the old module. Read-only's GET-works and POST-refused are asserted together (doctrine 16), and `is_active` is asserted *true* after each transition that used to set it false.

---

## Round 19 — 2026-09-30

**Scope:** The changes approved in `docs/approved-changes-2026-09-30.md`: what happens when Redis is unavailable, and the login limiter's ceiling. (The third, the web build, is Railway configuration: verified from a clean clone, but the config change was refused by this session's permission system as a production deploy — pending, see `docs/approved-changes-2026-09-30.md`.)

### M-01 — A Redis outage took every API request down, after a wait ✅ Fixed — decided: fail open

**Files:** `apps/api/src/middleware/rateLimit.ts`, `middleware/auth.ts`, `routes/auth.ts`, `routes/schools.ts`, `routes/sessions.ts`, `routes/announcements.ts`, `routes/messages.ts`; tests `rateLimitRedis.test.ts`, `authLockout.test.ts`, `authMiddlewareRedis.test.ts`

**The decision.** Rate limiting is a mitigation; the per-email lockout is the control; taking every school offline to preserve either is the wrong trade at 07:50 on a Monday. So while Redis is unavailable the app runs without it. Chosen, not defaulted: `passOnStoreError: true` is the opposite of the library's default and is set on purpose (doctrine 8).

**Four mechanisms, not two.** The handover named two; verification found four, and the last two would have kept the app down on their own:

1. *The limiter stores.* `express-rate-limit` 8.5.2 fails closed by default (`passOnStoreError: false`): a store error threw, and the general limiter sits on every `/api` request. Now `passOnStoreError: true` on all **five** limiters (general, auth, login, announcements, messages), with the library's own logger routed to winston as `rate_limit_store_unavailable` instead of the console.
2. *The lockouts' own Redis calls* — login (`routes/auth.ts`) and the payout step-up (`routes/schools.ts`; not in the handover, same shape). A rejection went to `next(err)` and became a 500. Each read, increment and delete is now best-effort (`bestEffort()`): a failed read skips the pre-check; a failed increment after a wrong password still answers 401 — never 500, never a lockout; a failed delete after a correct password still issues the token. Logged as `login_lockout_unavailable` / `step_up_lockout_unavailable`.
3. *Every authenticated request.* `verifyToken` reads the token blacklist and the `user_active` cache, and `requirePasswordChanged` the `must_change_password` cache, inside a try/catch that deliberately answered **503**. With 1 and 2 fixed, a Redis outage would still have refused every authenticated request. The two caches are now best-effort — a failure is a miss answered by the database, which decides anyway (a suspended user is refused with Redis down: tested). The blacklist check is best-effort on the reasoning `detectSupportSession` already fails open on the same key: the blacklist only ever holds support-session tokens, and those are also gated on the DB's `ended_at`. **This is the one extension beyond the handover's letter**, taken because its intent — the app keeps working — is not reachable without it. One hunk, easily reversed if the owner disagrees.
4. *The `current-context` cache* (`routes/sessions.ts`): best-effort; a failed invalidation leaves a stale entry for at most 60 s.

**Failing fast.** ioredis parks commands in an offline queue and rejects them only after 20 reconnect attempts, so "fail open" alone would have meant "wait tens of seconds, then pass". The shared client now has `commandTimeout: 500`: a command against a dead or hung Redis rejects within 500 ms (a healthy private-network Redis answers in under 10). During an outage a login costs about two extra seconds, not a refusal.

**The residual, stated plainly.** While Redis is unavailable, **both brute-force controls are inactive** — the per-address limiter and the per-email lockout — and so are the token blacklist and the caches. The condition is logged at `error` (`redis_client_error` on each failed reconnect, roughly every 2 s, plus the events above) and **is not currently alarmed**: nothing reads Railway's log stream. Wiring an alert is an open item in `docs/AUDIT-2026-09.md`; it was deliberately not built here.

**Not made best-effort:** the support-session token store and blacklist *writers* in `superAdmin.ts` (starting or ending an impersonation session needs Redis and may fail closed), and the cache invalidations after a suspension or password change in `users.ts`, `superAdmin.ts` and `routes/auth.ts` — a failure there is a 500 after a committed write, pre-existing and rare; listed rather than silently widened.

**Tests, doctrine 16.** Each proves the control bites first, then breaks Redis, then proves the request survives: the limiter (5 forgot-password requests then 429; broken → 200 and logged; repaired → 429 again); the lockout (5 wrong passwords lock the account; broken → the correct password signs in and a wrong one is 401 not 500, logged); the middleware (a second request is served from cache; broken → answered from the database with three events logged; a suspended user is still 403). Five new tests, and three rewritten to the new ceiling. Of those eight, six fail on the pre-change code — verified by stashing the seven source files and rerunning, not by inspection; the other two (the cache-in-use precondition, and the "once refused" guard, which 20 wrong passwords trip on either ceiling) pass on both by design.

### I-01 — Login limiter ceiling raised from 5 to 20 wrong passwords per minute per address ✅ Changed

**Files:** `apps/api/src/middleware/rateLimit.ts`, `rateLimitRedis.test.ts`

Both prerequisites recorded in Round 17 now hold: the per-email lockout has a test (`authLockout.test.ts`), and since Round 18 the address is the client's, so one school's router is one key — what the limit was always meant to measure. With `skipSuccessfulRequests` it counts only wrong passwords; twenty a minute from one school is Monday-morning typos and still a flood backstop. The `auth` limiter (forgot-password, reset, change-password) stays at 5: it counts successes by necessity. The per-email lockout (5 failures / 15 min) is untouched and remains the control; its test passes unchanged. The concurrency boundary (correct passwords in flight at once count until they answer) moves from 6 to 21 and is pinned.

---

## Round 18 — 2026-09-30

**Scope:** Round 17 left one reading unexplained: a single client, one address in Railway's own logs, one edge, landing on a second rate-limit counter about one request in five. Instrumented over five small deploys, each logging the *shape* of the client address and never the address — hop count, distinct-address count, whether a forged header survived the edge, and finally whether a config-held probe address (the prober's own) appeared in each header.

### H-01 — Every per-address control keyed on a Railway proxy address, not the client ✅ Fixed

**Files:** `apps/api/src/middleware/clientIp.ts` (new), `middleware/rateLimit.ts`, `routes/auth.ts`, `routes/schools.ts`, `routes/superAdmin.ts`, `routes/messages.ts`, `routes/announcements.ts`, `middleware/requestLogger.ts`; tests `clientIp.test.ts`, `rateLimitRedis.test.ts`, `authLockout.test.ts`, `requestLogger.test.ts`

**What was measured** (every probe, every time):
- `X-Forwarded-For` carries exactly **two** addresses, **distinct**, both public. A client-supplied `X-Forwarded-For` does not add a hop — the edge overwrites the header.
- `req.ip` (with `trust proxy = 1`, the last hop) is **not** the prober's address. Neither is the first hop.
- `X-Real-IP` **is** the prober's address, and a forged `X-Real-IP` does not survive the edge either.

So on Railway, `X-Forwarded-For` holds two Railway addresses and no client, and Express's `trust proxy` — which reads only that header — can never yield anything but a Railway proxy, at any depth setting. The client is in `X-Real-IP`, which is what Railway's public-networking spec documents as "the client's remote IP" (it does not document `X-Forwarded-For` at all).

**What that meant, since launch:**
- Both rate limiters, the login limiter and the per-address login lockout counted **every school through a given proxy as one client**. The 100/min general limit was a platform-wide budget per proxy; `MAX_IP_ATTEMPTS = 20` failed logins in 15 minutes, from anyone, locked out every user routed through that proxy until someone logged in successfully (which clears the key). Not reached only because no real school is live.
- The one-in-five "second counter" was the same client's requests taking a different proxy.
- The `ip_address` written to `audit_logs` on every super-admin action (impersonation start, school wipe, suspensions, subscription changes — 17 sites) and to the payout step-up lockout was a Railway address, not the actor's. **Every such row written before this fix records the wrong address; do not read them as actor location.**

**Fix:** `clientIp(req)` returns `X-Real-IP` when it holds a valid address (IPv4-mapped forms unmapped), else `req.ip`. Every former `req.ip` reader uses it. The limiters key on `ipKeyGenerator(clientIp(req))`, so an IPv6 client is folded to its /56 as before. `trust proxy` stays at 1 — it no longer decides anything security-relevant, and turning it off would put a Railway address in `req.ip` on the fallback path.

**Off Railway** (local dev, tests, a direct hit on the container over private networking) nothing overwrites `X-Real-IP`, so there it is exactly as trustworthy as `X-Forwarded-For` was under `trust proxy` — the risk Round 4 M-02 accepted. Not a new exposure: the same requester could already choose `req.ip` there.

**Tests:** 8 new behavioural tests, 6 of which fail with `clientIp` temporarily returning `req.ip` (verified): one client through two proxies is one counter; two clients through one proxy are two; 100 requests from other clients through the same proxy leave a client's allowance untouched; the login lockout key is the client, not the hop; and the helper prefers `X-Real-IP` and unmaps it. The two fallback tests (header absent, header malformed) pass on both by design.

**Round 4 M-02, superseded.** It accepted "trust proxy 1 IP spoofing" as a risk. Measured: through the edge, neither header can be spoofed — the risk accepted was not present — but the header Express read never held the client. The accepted risk was the wrong one.

**Verification after deploy:** the same probe fields, plus the limiter's own `RateLimit-Remaining` header over 30 requests from one client: one counter, decreasing by one each time, no second key.

---

## Round 17 — 2026-09-30

**Scope:** Round 16's fix went live at 15:57:31 on 28 Sep. Railway's logs for the next minute: five correct passwords from one address in 35 seconds, then 429 in 28 ms on the sixth. Specified by the second reader in `docs/rate-limit-remediation.md`; three of its points corrected on verification (recorded at the top of that document).

### M-01 — The login rate limit refused correct passwords ✅ Fixed

**Files:** `apps/api/src/middleware/rateLimit.ts`, `apps/api/src/index.ts`, `apps/api/src/__tests__/rateLimitRedis.test.ts`, `CLAUDE.md`

**Fix:** The auth limiter counted every request, so a limit whose only job is stopping guesses spent itself on logins that were not guesses. It was not a deviation from the spec: Agent File Rule S5 prescribes `app.use('/api/auth', rateLimit({ windowMs: 60000, max: 5 }))` verbatim. So the rule is amended (CLAUDE.md "Spec drift"), or a later pass would read the fix as a violation and restore it.

`POST /login` now has its own limiter (`rl:login:`) with `skipSuccessfulRequests`: a response under 400 is taken back off the count once sent, so wrong passwords (401), lockouts (429) and malformed requests (400) count, and correct passwords do not. Every other `/api/auth` route keeps the counting-everything limiter — deliberately: `forgot-password` answers 200 whether or not the account exists, so a failures-only limiter would never count it, and it sends email. The spec as written put the failures-only limiter on `forgot-password` too; that is the one change here that would have opened something.

Mounting moved into `mountRateLimiters()`, called by both `index.ts` and the test, so the test drives the production mounting rather than a copy that can drift. 7 tests on the fake-Redis harness; the two describing the defect (30 correct passwords all admitted; logins and forgot-password not sharing an allowance) fail on the old code. The other five pass on both and are there to fail if a later change loosens the wrong thing: the sixth wrong password is refused; a correct password after five wrong ones from the same address is refused; the sixth forgot-password request is refused though all five "succeeded".

**Deliberately not done yet:** raising `max` from 5 to 20. It is defensible only with a test that the per-email lockout carries the load (five wrong passwords for one email from five addresses, then the correct password from a sixth, refused) — not written yet. Until then, six correct logins from one address *in flight at the same moment* still count six, because the count is decremented when a response is sent.

**Found while verifying, not fixed here:**
- *A Redis outage fails every `/api` request, not just login.* `passOnStoreError` defaults to `false` in express-rate-limit 8.5.2, and ioredis retries each command 20 times first. Whether an outage should take the product down or suspend rate limiting is a policy decision, open with the product owner.
- *Per-address counting is not fully stable.* One client, one address in Railway's logs, one edge: about one request in five was counted under a different key. Not client-spoofable (a forged `X-Forwarded-For` opened no new key); cause under instrumentation (`http_request.client_ip`, which logs the shape of the address and never the address).
- *The per-IP login lockout resets on any successful login from that address,* so anyone holding one valid account can clear it between guesses. The per-email lockout is the control that holds.

---

## Round 16 — 2026-09-28

**Scope:** Reported from production: a principal logging in again seconds after a successful login was refused with "Too many requests, please try again later." The http logs showed one login from that IP in the preceding minute against a limit of five.

### M-01 — The login limit was spent by ordinary use of the app ✅ Fixed

**Files:** `apps/api/src/middleware/rateLimit.ts`, `apps/api/src/__tests__/rateLimitRedis.test.ts`

**Fix:** `authRateLimiter` (5/min on `/api/auth`) and `generalRateLimiter` (100/min on `/api`) both used `rate-limit-redis` with its default prefix `rl:` and both key by client IP, so in production they read and wrote **one Redis key per client**. Every request anywhere under `/api` spent the login allowance, and a login — which passes both mounts — spent it twice. A principal who logged in, used the dashboard (four requests) and saved a setting was refused on the next login in 32 ms, before the password was checked. With no browsing at all, the third login in a minute was refused: the effective limit was about two, not five. This is availability, not exposure — the limiter only ever refused more than intended — but a limit that locks out legitimate users trains them to distrust the error, and hides the real one when it fires.

Each limiter now has its own prefix (`rl:auth:`, `rl:general:`). The announcement and message limiters were already safe: their key generators namespace the key (`ann:`, `msg:`).

The existing unit test could not see this: without `REDIS_URL` each limiter gets its own in-process MemoryStore, so the collision existed only on the path production runs. The limiters are now built by `createRateLimiters(sendCommand?)`, and `rateLimitRedis.test.ts` drives the Redis path with one fake Redis (implementing the store's two Lua scripts) shared by both stores, as the one real Redis is. 3 tests, all 3 failing on the old prefixes: browsing does not spend the login allowance; the 6th auth request in a minute is still refused; the two counters live under distinct keys.

**Not changed, and worth a decision:** the auth limit is 5 per minute **per IP**, counting successful logins. Staff behind one school router, or parents on a carrier-grade-NAT mobile network, share an IP. `skipSuccessfulRequests` would count only failures, but `/api/auth` also serves `forgot-password`, which answers 200 whatever the email — so it would stop counting the requests that send email. A per-route limit is the shape of that change, not a flag.

---

## Round 15 — 2026-09-28

**Scope:** Surfaced by reading the audit rows behind the first production use of *Grading by Level*: two saves of the same level override eighteen seconds apart, the second recording its predecessor as having set nothing.

### M-01 — Grading and fee settings changes were audited with a fabricated prior value ✅ Fixed

**Files:** `apps/api/src/db/queries/schools.ts`, `apps/api/src/routes/schools.ts`, `apps/api/src/__db_tests__/settingsAudit.db.test.ts`, `apps/api/src/__tests__/schoolQueries.test.ts`, `apps/api/src/__tests__/schools.test.ts`

**Fix:** `PATCH /academic-config` (grading scales, pass marks, level overrides) and `PATCH /fee-config` (the part-payment minimum) passed a **literal `null`** to `logSettingsChange` as the old value. The audit stores `{ field, value }`, so the column was never NULL — it read as a *recorded* prior value of "nothing", on every such change, whatever had actually been there. A missing value announces itself; a false one reads as authoritative, and it is the field an audit trail exists to answer — in a table that is append-only, trigger-enforced and, after C-4a, privilege-enforced precisely so its contents can be trusted. (The other four `logSettingsChange` call sites already passed real prior values.)

Both paths now read the prior value of exactly the keys being changed **inside the transaction that writes them**: ensure the row exists, `SELECT … FOR UPDATE`, merge, commit — so the recorded prior is the state that immediately preceded this write, and a concurrent save waits on the lock and then records the other's result. Old and new line up key for key.

A first attempt put the read in the same statement as the upsert (a `FOR UPDATE` CTE). It returned nothing: the upsert CTE ran first, and `FOR UPDATE` skips a row already modified by the same command. The positive test caught it on its first run — the second of two saves must name the first save's value — where an assertion that the old value is null would have passed against the broken code. A concurrency test holds the row lock, confirms both saves are waiting on it, then releases: removing `FOR UPDATE` fails it every time, not by chance. 6 tests, all 6 failing on the pre-fix code except the concurrency one, which was written against the fix and verified against a lockless variant.

Also: `updateFeeConfig` was the same `UPDATE … WHERE school_id` that matched zero rows for a school without a settings row while the route answered "Fee settings updated" — the defect fixed for academic config in 28 Sep's grading-page change. Both now upsert.

**What this means for existing rows:** every `SETTINGS_CHANGE` audit row for grading or fee settings written before this fix records `value: null` as its prior — not evidence of an empty prior. Reconstructing a history needs the sequence of `new_value`s, not the `old_value`s.

---

## Round 14 — 2026-09-28

**Scope:** Found by running the DB suite under the C-4a app role: the next test's seed deadlocked with an `INSERT INTO audit_logs` from the previous test that was still running after its request had returned. Postgres's deadlock report named it.

### M-01 — The notification queue was written fire-and-forget, and the response claimed it had been ✅ Fixed

**Files:** `apps/api/src/routes/results.ts`, `attendance.ts`, `behaviour.ts`, `announcements.ts`, `roster.ts`, `sessions.ts`, `apps/api/src/__db_tests__/notificationQueue.db.test.ts`

**Fix:** `audit_logs` rows with `PARENT_NOTIFICATION_QUEUED` / `TEACHER_NOTIFICATION_QUEUED` *are* the notification queue — `notificationWorker` reads them. `POST /results/publish` wrote that row with `logAudit(…).catch(() => {})`, not awaited, and answered *"Results published. Parent notifications have been queued."* regardless. If the write failed — a pool timeout, a deadlock, a constraint — results were published, the principal was told parents had been notified, no queue row existed, and nothing anywhere recorded the failure. `POST /results/return` did the same for teachers ("Teachers have been notified"). The low-attendance and behaviour alerts wrote their queue rows the same way.

The two results routes now await the queue write and report it: `notifications_queued: true|false`, with a message that says plainly when parents or teachers could **not** be notified, and a `parent_notification_queue_failed` / `teacher_notification_queue_failed` error log. Publishing is not undone when the queue write fails — the results are published — but nobody is told a notification went out when it did not. The attendance, behaviour and announcement writes are awaited and their failures logged instead of swallowed. Four more audit writes (`TERM_CREATED`, `TERM_UPDATED`, `TEACHER_ASSIGNMENTS_BULK_CREATED`, `TEACHER_ASSIGNMENTS_COPIED`) were awaited but ended in `.catch(() => {})`: a sensitive write could lose its audit row with no trace (doctrine 10). Now logged.

`notificationQueue.db.test.ts` forces the queue write to fail with a trigger that rejects exactly that row, so its tests fail on the old code deterministically rather than by losing a timing race — 4 of 4 on the old code, 4 of 4 passing on the new.

**Not changed, named instead:** in-app message notifications and welcome emails (including the ones that carry a parent's first login credentials) are still sent fire-and-forget with failures swallowed. That belongs to the messaging audit on the standing list, where it is recorded.

---

## Round 13 — 2026-09-28

**Scope:** The one database connection opened on behalf of an unauthenticated caller. Surfaced by the second read of the C-4a artifacts.

### M-01 — The login connection bypassed the verified-TLS configuration ✅ Fixed

**Files:** `apps/api/src/routes/auth.ts`, `apps/api/src/db/client.ts`, `apps/api/src/__tests__/auth.test.ts`, `apps/api/src/__tests__/authSeedTestUserSecurity.test.ts`

**Fix:** The pool's TLS is resolved by `resolveSsl()` — bundled Supabase CA, `rejectUnauthorized: true`, fail-closed — and every boot logs `pg_tls_verified`. POST /login does not use the pool: it opens its own `pg` Client, which was built as `new Client({ connectionString })` with **no `ssl` option at all**. Its TLS was therefore whatever the connection string implied, verified or not, while the boot log's single `pg_tls_verified` line described only the pool — true, and incomplete. That connection carries the user lookup (id, role, school, email) for every login.

`resolveSsl()` now takes the URL and a connection label, and the login client resolves through it once at load, so it is verified exactly as the pool is and the boot log carries a `pg_tls_verified` line per connection (`connection: "pool"` / `"login"`). Both connections read the same `DATABASE_URL`, and the pool already verifies against it in production, so the change cannot introduce a handshake failure the pool does not already survive.

Also: `/create-user` (super_admin) and `/seed-test-user` (off in production) used the same client. They moved to the app pool, so the login connection now serves POST /login alone — which is what lets C-4a give it a role holding ten `users` columns, one `schools` column and `UPDATE (last_login_at)`, and nothing else (`docs/c4a/grants.sql`, probed in `docs/c4a/probe.md`). The unit-test mocks were routed so both routes' success tests genuinely exercise the pool: unrouted, their duplicate checks would see the middleware's fixed row and return 409.

---

## Round 12 — 2026-09-27

**Scope:** Reconciling every RLS policy in production against what `migrations/` creates. A pre-C-4b step: C-4b turns these policies into the enforcement layer, and it cannot be sized against a policy set nobody has checked.

### M-01 — 17 production RLS policies existed in no migration, one of them created by hand ✅ Fixed

**Files:** `migrations/042_rls_policy_reconciliation.sql`, `scripts/sql/rls_policy_inventory.txt`, `scripts/sql/rls_drift_check.sql`, `scripts/sql/rls_policy_dump.sql`, `apps/api/src/__db_tests__/rlsPolicyDrift.db.test.ts`

**Method:** Rebuilt the schema from `migrations/` into an empty database, then compared `md5(tablename|policyname|cmd|roles|qual|with_check)` against production, both directions.

**Result:** 64 policies from migrations, 81 in production. Every one of the 64 matched production byte for byte — no policy had a different predicate in the two places. The gap was 17 policies that exist in production and in no file:

- **16 × `service_role_bypass`** on the tables created by migration 001, which predates the convention that every table carries one. Codified by 042 rather than dropped: `service_role` holds the BYPASSRLS attribute today (`pg_roles.rolbypassrls = true`, verified), which makes them inert — but C-4a replaces BYPASSRLS with exactly this kind of per-table permissive policy, at which point the shape matters.
- **1 × `"Users can read own notifications"`** on `notifications` — title-cased, `SELECT`, `TO authenticated`, `USING (user_id = auth.uid())` — created in the Supabase dashboard. Strictly a subset of `notifications_user` from `020_rls_policies.sql`, which is `FOR ALL`, `TO public`, on the identical predicate; both PERMISSIVE, so dropping it removes no access. No web code reads Supabase tables directly, so nothing referenced it by name. Dropped by 042.

**Why this was invisible:** `tenantIsolation.db.test.ts` asserts that every public table has row level security *enabled*. That was true on both sides throughout — the guard is real, it passed honestly, and it measures a property that cannot fail when this fails. A rebuild from `migrations/` would have produced a database 17 policies short of production and nothing would have said so.

**The guard now has two halves, because no single one reaches both databases.** `rlsPolicyDrift.db.test.ts` pins the migration side against a checked-in inventory, so any policy change fails CI until the inventory is regenerated and shows up in a diff. `scripts/sql/rls_drift_check.sql` is run by hand against a deployed database and is the only half that can see a policy created in the dashboard. Verified to fail against the pre-042 code, naming all 16 missing policies.

**Not changed, deliberately:** six platform tables (`onboarding_sessions`, `platform_announcements`, `platform_audit_logs`, `platform_metrics_snapshots`, `platform_subscriptions`, `support_sessions`) carry no `service_role_bypass` in production *or* in migrations. They agree, so they are not drift. Giving them one would be a change to production's access surface dressed as a reconciliation.

---

## Round 11 — 2026-09-26

**Scope:** How accounts are created and how their first credentials are issued. Prompted by a live registration whose account could not log in.

### H-01 — Registered students and parents were given login rows with no auth identity ✅ Fixed

**Files:** `apps/api/src/db/queries/students.ts`, `apps/api/src/routes/students.ts`, `apps/api/src/__db_tests__/registrationIdentity.db.test.ts`

**Fix:** Login is `supabase.auth.signInWithPassword`, and the local `public.users` row is then resolved **by the auth id that call returns**. `users.password_hash` is read in exactly one place — verifying a change-password request (`routes/auth.ts`). So a `users` row whose id is not the id of a real Supabase Auth account can never be logged into, whatever password was set on it.

`registerStudent` created its `users` rows with a Postgres-generated id and never called Supabase Auth at all. Every student registered through the registrar flow, and **every parent account created alongside them**, was unusable. The parent case is the damaging one: the route emails those parents a welcome message containing credentials that cannot work, so the failure surfaces to an outside user, not to staff. It also hit bulk import, at one broken account per imported row.

`registerStudent` now takes an injected `CreateAuthAccount` and binds the returned id as `users.id` for the student and for each newly created parent. Following the pattern already documented in `routes/users.ts`, the auth calls run **outside** the DB transaction: an external API call inside one orphans the remote account whenever the DB later rolls back. The accepted trade-off is unchanged — a failure after account creation leaves an orphaned Supabase identity, which is recoverable; a local row with no identity is not.

Regression coverage in `registrationIdentity.db.test.ts` asserts a registered student **and every parent created with them** join to an auth identity — verified to fail against the pre-fix code (3 of its 4 tests).

### M-01 — Bulk import gave every account at every school the same repo-readable password ✅ Fixed

**Files:** `apps/api/src/routes/students.ts`, `apps/api/src/routes/users.ts`, `apps/api/src/services/bulkImportResults.ts`, `apps/api/src/services/staffBulkImportResults.ts`, `apps/web/app/(dashboard)/settings/users/import/page.tsx`

**Fix:** Both import paths hardcoded `Password2$` — `BULK_IMPORT_PASSWORD` for students and parents, `STAFF_BULK_IMPORT_PASSWORD` for staff. The staff case was directly exploitable: those accounts do get a working Supabase Auth identity, so anyone who had read the repo, or who had ever been imported at any school, could log into any freshly imported staff account. `must_change_password` confines the session to the change-password route, but that is enough to take the account over before its owner's first legitimate login. This had to be fixed in the same change as H-01, because H-01 is what would have made the student and parent accounts reachable too.

Each account now gets its own `randomBytes(9).toString('base64url')` password. Staff and parents receive theirs by email; students, who have no email address of their own, receive theirs in the import results workbook, which now prints a per-student password column and tells the registrar to delete the file after handing them out. The staff hash moved from a hoisted `bcrypt.hashSync` to a per-row `await bcrypt.hash` — sharing one hash was a deliberate event-loop optimisation, and the async call keeps it off the event loop now that each row differs. A welcome email is no longer sent at all when no password was recorded for that address, rather than sending a blank one.

**Throughput note:** bulk import is now ~3.4s/row, up from ~2.7s/row, because each student and each new parent costs one Supabase Auth round-trip and one bcrypt hash. A full 50-row commit is a ~3-minute synchronous HTTP request. `MAX_BULK_IMPORT_ROWS` was not changed.

---

## Round 10 — 2026-09-23

**Scope:** A full pass over every role's read and write surface — principal, teacher, parent and student — covering route guards, frontend↔backend wiring, and whether each role can reach data belonging to someone else. Four parallel reviews, each finding independently re-verified against the source before being accepted.

### H-01 — Parents and students could see unpublished (draft) results ✅ Fixed

**Files:** `apps/api/src/routes/parent.ts`, `apps/api/src/routes/student.ts`, `apps/web/app/(parent)/parent/results/page.tsx`, `apps/web/app/(student)/student/results/page.tsx`, `apps/api/src/__db_tests__/resultVisibility.db.test.ts`

**Fix:** Four endpoints — the parent snapshot and results routes, and the student dashboard and results routes — each fetched `getResultStatus(...)` and then used it **only to echo back in the response payload**. The score data itself came from `computeClassResults`, whose query reads the `scores` table with no join to `result_status` or `subject_result_status`. The practical effect: a parent or student saw a score the instant a teacher typed it — before subject submission, before the principal approved, and before anything was published. Doctrine 5 states `published` is the parent/student-visible state.

Two things let this persist. The earlier fix recorded as Round 5 L-01 gated only the **report-card PDF** (`report_cards.is_published`), not the live-computed JSON score routes — so the workflow *looked* addressed. And a comment in `results.ts` asserted that "the parent- and student-facing routes (which gate on `is_published = TRUE`)", which is true of the PDF route alone and would reassure anyone who read it. That comment has been corrected.

All four routes now require `result_status === 'published'` before populating any score data, and both web pages render an explicit "Results not published yet" panel instead of a blank table. Regression coverage in `resultVisibility.db.test.ts` — verified to fail against the pre-fix code.

### M-01 — Attendance read paths lacked the assignment check their write path enforced ✅ Fixed

**Files:** `apps/api/src/routes/attendance.ts`, `apps/api/src/db/queries/attendance.ts`

**Fix:** `POST /attendance/mark` has always verified the caller is the class's form teacher or holds a `teacher_assignments` row for it, with a comment explaining why. `GET /attendance/class` and `GET /attendance/monthly-summary` checked only `requireRole(...)` plus "does this class exist in this school" — so any teacher could pull the full roster (names, admission numbers, per-day status) and 30-day history of a class they have no relationship to. `GET /:schoolId/classes` has no role restriction, so discovering class ids is trivial. Added `canTeacherViewClass`, backed by a new term-agnostic `isTeacherAssignedToClassAnyTerm` query (reads may legitimately span past terms; the write path keeps its stricter term-specific check). Principals and super_admins bypass, as before.

### M-02 — `POST /behaviour` validated neither the reporter's assignment nor the student's enrollment ✅ Fixed

**Files:** `apps/api/src/routes/behaviour.ts`, `apps/api/tests/notificationPipeline.test.ts`

**Fix:** The route confirmed the student existed in the school and the class existed in the school — but never that the student was *in that class*, nor that the reporting teacher had any relationship to it. A `severity: 'suspension'` record notifies the parent immediately, so this let any teacher trigger a real parent notification against any student in the school, citing an arbitrary class. Now validates enrollment via `findStudentsNotInClass` (the same doctrine-3 helper `scores` uses) and requires the reporter to be the form teacher or assigned to the class for the current term. Surfaced a fixture gap in `notificationPipeline.test.ts`, which had been creating a `students` row with no `student_classes` enrollment and only passed because the validation was missing.

### M-03 — Principal dashboard capability built but never wired ✅ Fixed

**Files:** `apps/web/app/(dashboard)/principal/dashboard/page.tsx`

**Fix:** Four of the five `dashboard/principal/*` endpoints had no frontend consumer at all — `students-at-risk`, `teacher-activity`, `result-status` and `class-selector`. Not a security issue, but `getStudentsAtRisk` and `getTeacherActivity` are exactly the oversight a principal needs and were invisible. Both are now rendered on the principal dashboard, loading independently so a failure in either cannot blank the page. `result-status` and `class-selector` were left unwired deliberately — they duplicate the existing results page and roster endpoints respectively.

### L-01 — `parent_students` link had no tenant guarantee of its own ✅ Fixed

**Files:** `migrations/033_parent_students_tenant_consistency.sql`, `apps/api/src/db/queries/parents.ts`

**Fix:** `parent_students` carries no `school_id`, so `isParentLinkedToStudent()` matched on `(parent_id, student_id)` alone — the most security-sensitive join in the parent portal, with no tenant filter. Not exploitable (every caller pairs it with `requireSchoolAccess` and a school-scoped query, and a check confirmed zero cross-school links exist), but it meant the guard depended entirely on its callers. The query now also requires parent and student to share a school, and migration 033 adds a trigger rejecting any cross-school link at write time — same approach migration 029 uses for `scores`. Verified against production inside a rolled-back transaction: the insert is refused with "parent school does not match student school".

### L-02 — Announcements left no audit trail ✅ Fixed

**Files:** `apps/api/src/routes/announcements.ts`

**Fix:** A principal-only, school-wide broadcast that reaches every targeted user's inbox and email had no `logAudit` call anywhere in the route or its queries, while 10+ other route files log far less consequential writes. Now recorded as `ANNOUNCEMENT_CREATED`, non-blocking so a logging failure can never fail the broadcast.

### L-03 — Parent and student route groups did not check role ✅ Fixed

**Files:** `apps/web/app/(parent)/layout.tsx`, `apps/web/app/(student)/layout.tsx`

**Fix:** Both layouts checked only that *someone* was signed in, so any authenticated user could open `/parent/*` or `/student/*` and get a rendered shell whose data calls then 403'd. The API was never at risk — this is a UX correctness fix. Non-matching roles are now redirected to their own landing page via `getDefaultDashboardPath`.

### L-04 — Any authenticated user could read any class's timetable ✅ Fixed

**Files:** `apps/api/src/routes/timetable.ts`, `apps/api/src/db/queries/timetable.ts`

**Fix:** `GET /timetable/class/:classId` took `classId` straight from the path with no check beyond school membership. Staff legitimately need any class, so the restriction applies to the student role: a student may now only read a class they are or were enrolled in (past sessions included, so an earlier term's schedule still resolves).

### L-05 — Past-term results were labelled with the student's current class ✅ Fixed

**Files:** `apps/api/src/routes/student.ts`, `apps/api/src/routes/parent.ts`

**Fix:** `summarizeStudent` took `enrollments[0]`, and enrollments are ordered by session start descending — so selecting an older term showed correct scores under the wrong class name. Both copies now prefer the enrollment matching the class the requested term actually resolved to, falling back to the latest only when unknown.

### L-06 — Timetable could not distinguish "no active term" from "no slots" ✅ Fixed

**Files:** `apps/api/src/routes/timetable.ts`, plus the three web consumers

**Fix:** Both GET routes returned a bare `data: []` when no term was active, identical to a term with no slots scheduled — a blank timetable gave the viewer no way to tell whether the school had forgotten to activate a term or simply not built the schedule. The teacher page's own empty-state text ("No active academic term, or no periods have been assigned to you yet") encoded the ambiguity. Responses now carry `{ term_id, reason, slots }`, and each page states which case applies.

### Withdrawn — `GET /:schoolId/users` open to all roles ❌ False positive

Reported during this round as a High-severity PII exposure and **retracted after verification**. Recorded here because the misreading is easy to repeat: the route carries no `requireRole`, which in every other route file would mean "any authenticated member of the school." But `users.ts` defines its **own** `requireSchoolAccess` that admits only super_admin and principal. The endpoint was never open.

The real defect underneath was smaller: the teacher class-comments page called that admin-only endpoint to fetch its own `signature_url`, received 403, and swallowed it in a `.catch(() => {})` — so teachers never saw their signature. Fixed by adding `GET /:schoolId/users/me` (permissive guard, resolves the caller from the JWT, no id accepted from the request) and pointing that page at it. An explicit `requireRole` was also added to the list route as defence in depth, so the restriction survives future edits to the local helper.

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
| M-02 | trust proxy 1 IP spoofing | ⚠️ Accepted risk → **superseded by Round 18 H-01**: the address Express read was never the client's |
| M-03 | Impersonation actions logged under victim's ID | ✅ Fixed |
| M-04 | JWTs stored in localStorage | ⚠️ Accepted risk |
| L-01 | bcrypt cost factor 10 | ✅ Fixed |
| L-02 | Plaintext temp passwords in API response body | ✅ Fixed |

---

## Reporting a vulnerability

If you discover a security issue in Chronix Edu, please email **joshua4moses@gmail.com** with a description and reproduction steps. Do not open a public GitHub issue for security findings.
