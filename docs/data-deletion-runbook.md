# Data deletion runbook: one school, on termination

**What we promised.** DPA §11 and Terms §22 (do not edit; once a school accepts them they bind, via
`legal_terms_accepted_at`). As of 1 Oct 2026 **no third party has accepted them**: every school in
production is a fixture, a demo, or Moses's own pilot. So this is pre-launch hardening, and it must
be finished and proven **before the first real school signs**, because that signature makes all of
it binding at once.

> On termination of the Service, the School has thirty (30) days to request a complete export of
> its data in a portable format (CSV or PDF). Chronix Edu will permanently delete the School's
> Personal Data from its systems and those of its Sub-processors within ninety (90) days of
> subscription termination, except where retention is required by applicable law.

This document is the process that keeps that promise. It was asked for in
`docs/approved-changes-2026-09-30-public-claims.md` §1; the audit-log decision it left open was made
on 1 Oct 2026 (option (a), [below](#the-decision-made-1-oct-2026-option-a)) and built as migration
048. A completed run leaves **zero rows** for the school in every table, checked inside the
deleting transaction.

## Timeline

| Day | What happens | Who |
|---|---|---|
| 0 | Subscription terminated (school asks to leave, or does not renew and says so). Record the date in the support ticket. **Read-only is not termination**: a read-only school may still renew, and its data stays. | Chronix |
| 0–30 | School downloads its data: principal → **Settings → Data Export** (every table, one CSV each; works while read-only). Files (report-card PDFs, photos, submissions) are **not** in the export yet. See [Known gaps](#known-gaps). | School |
| 31 | Run the deletion (below). | Chronix |
| 31–90 | Sub-processor copies expire or are deleted (table below). | Chronix / automatic |
| ≤ 90 | Promise met. Close the ticket with the script's output attached. | Chronix |

## Procedure

1. **Save what Chronix must keep for itself.** `platform_subscriptions` is Chronix's own billing
   record for the school, and the script deletes it. Before running, save it to the accounts:
   ```sql
   SELECT * FROM platform_subscriptions WHERE school_id = '<id>';
   ```
   Whether anything else is "retention required by applicable law" is **[MOSES]**, for the adviser.
   School-fee payments made by parents are the *school's* records, which it has exported.
2. **If the school is still active, suspend it** (Super-admin → Suspend) so nothing writes while you
   delete. A write that lands mid-run is not dangerous: the final in-transaction check sees the new
   row and rolls the whole run back, and you rerun. Suspending just avoids the rerun.
3. **Dry run** (changes nothing), from a machine with the production env:
   ```bash
   DATABASE_URL=<production pooler url> \
   node apps/api/scripts/delete-school-data.js --school <school-uuid> --allow-host <db host>
   ```
   Check the school name and slug it prints. **Copy the address lists it prints** ("Copy these
   now") into the ticket: every email address and phone number the run removes. After the run they
   exist nowhere in our database, and two sub-processors keep their own copies (step 5).
4. **Execute:**
   ```bash
   DATABASE_URL=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
   node apps/api/scripts/delete-school-data.js --school <uuid> --allow-host <db host> \
     --execute --confirm <school-slug> --operator <your super-admin email> --with-supabase
   ```
   Guards, each tested: refuses a non-local database unless `--allow-host` equals the URL's host;
   refuses `--execute` without `--confirm <slug>`, without `--operator` (who must be an active
   super admin outside the school), or without exactly one of `--with-supabase` / `--skip-supabase`;
   refuses `--with-supabase` without credentials. Every refusal says "Nothing was changed." The
   service key is never printed (checked with a sentinel).
   Order: Supabase Auth accounts and Storage files first, stopping if any fails; then **one
   database transaction**, children before parents, ending with `audit_logs` (through
   `chronixedu_purge.purge_school_audit_logs`), `platform_audit_logs`, `users`, `schools`. Before
   committing it recounts every table and rolls back unless all are zero.
5. **Sub-processors.** Work through the table below. Two need the addresses from step 3:
   - **SendGrid**: remove each email address from Suppressions (bounces, blocks, spam reports,
     unsubscribes), in the dashboard or `DELETE /v3/suppression/{type}/{email}`. Suppressions never
     expire on their own.
   - **Termii**: send the phone numbers with the deletion request (see the Termii row; there is no
     process yet).
6. **Confirm.** A second dry run must print `Nothing to delete: there is no school <id>, and no row
   in any table refers to it.` Nothing else counts as done. The one row that remains on purpose is
   the record of the purge (`platform_audit_logs`, `SCHOOL_AUDIT_PURGED`, school id in `metadata`,
   no personal data).

## Every system that holds school data

| System | What it holds for a school | How it is deleted | Status |
|---|---|---|---|
| **Supabase Postgres** (`public`) | Every table. The export covers all of them; `schoolExport.db.test.ts` fails if a new table is not classified. | The script, in one transaction, verified zero before commit. `schoolDeletion.db.test.ts` fails if a new table is in neither `STEPS` nor `NOT_DELETED`. | ✅ including the audit tables, users and school row (migration 048). |
| **Supabase Auth** | One account per user: email, password hash; `identities` and `sessions` cascade. `auth.audit_log_entries` is empty in production (checked 1 Oct 2026), so login history is not kept in the database. | The script, `--with-supabase` (the same `auth.admin.deleteUser` the super-admin screen uses). Every Auth user has a `public.users` row (checked), so the script sees them all. | ✅ |
| **Supabase Storage** | `school-assets/schools/<id>/…` (logo, signature, stamp, student photos, staff signatures, assignment files) and `report-cards/{<id>, receipts/<id>, transcripts/<id>}/…`. All 15 production files matched these four prefixes (checked 1 Oct 2026). | The script, `--with-supabase`, through the Storage API (a row delete would leave the file), then re-listed to prove it is empty. | ✅. **3 orphaned files exist today**: `school-assets` files for schools already wiped by `seed-child-prime.js`, which deletes schools but not their files. Remove by hand. |
| **Supabase backups** | Production is on the **free plan** (one organization, `CHRONIX TECHNOLOGY LIMITED`, holding Chronix Edu and Chronix ERP; measured 1 Oct 2026). Supabase backs up Pro/Team/Enterprise daily (7/14/30 days); for free projects it "currently" takes up to 7 daily backups, reachable only after upgrading, and "might no longer" do so. | Not deletable; they expire. At most 7 days, well inside 90. | ✅ by expiry. Terms §19's "routine backups" becomes true on the **Pro upgrade, decided and budgeted, before the first real school signs** (open item in `docs/AUDIT-2026-09.md`). |
| **Supabase logs** (API/Postgres log explorer) | Request metadata; no bodies. | Expire by plan (free: 1 day). | ✅ by expiry |
| **Railway logs** | API logs. Personal data appears only on email-send failure (`sendgrid_email_failed`, `email_queue_retry_failed` log the recipient address). | No per-record deletion. Retention by plan: Free 3 d, Trial/Hobby 7 d, Pro 30 d, Enterprise up to 90 d. | ✅ by expiry on any plan. **[MOSES]** confirm the plan (the API does not expose it). |
| **Sentry** | Error events and session replays. User **id** only since `58eca29` (30 Sep 2026, 23:43 UTC); before that, user emails. Replays mask all text and inputs and block media. | Events expire: **90 days on the business plan**. | ✅ by expiry. The last email-bearing events age out by about **29 Dec 2026**. Check in January (open item). |
| **SendGrid** | Email Activity (recipient, subject, status) and suppression lists (bounces, blocks, spam reports, unsubscribes), which **do not expire**. | Activity expires (3 days by default, 30 with the extended-history add-on). Suppressions: per address, from the list the script prints (procedure step 5). | Suppressions ✅ by the procedure. **[MOSES]** verify the Activity retention in the dashboard. |
| **Termii** | SMS history: parent phone numbers and message text (attendance alerts). | **Unknown. No deletion API we use.** The script prints the numbers to put in a request. | 🔴 **A real hole in a 90-day promise, not a formality.** **[MOSES]** ask Termii how long message logs are kept and how to request deletion. |
| **Paystack** | Transactions for school-fee payments: payer email, amount, reference. | Merchants cannot delete transactions; Paystack keeps them under its own regulatory obligations. | Legal-retention exception, by Paystack's obligation not ours. **[MOSES]** confirm with the adviser. |
| **Opay** | Named in the DPA; **no integration exists in the code** (grep). | Nothing to delete. | ✅. [MOSES] the DPA lists a sub-processor we do not use; harmless, but worth tidying at the next legal revision. |
| **Cloudflare** | Named in the DPA as CDN; configured outside this repo. | Request logs, if any, expire by plan. | **[MOSES]** confirm whether Cloudflare is in front of the domain today. |

## The decision, made 1 Oct 2026: option (a)

**Delete, via a named purge path** (Moses). (b) anonymise was rejected; (c) retain was not needed.

- The adviser's position is that scrubbing identifying fields would satisfy "permanently delete".
  That made (b) *legal*, not *better*; (a) is strictly stronger and meets the same test.
- (b) would have scrubbed two arbitrary-shape JSONB columns. Measured in production on 1 Oct 2026,
  00:45 UTC: **269 audit rows, 20 distinct `action_type` values, 50 distinct payload keys** across
  `old_value ‖ new_value`. The code can emit **38 distinct `actionType:` literals** (non-test code)
  plus the `logSettingsChange` wrappers. So a scrubber would have handled every shape while only
  20 existed to test against, and a missed key is personal data we had told a school we deleted.
  Two corrections on the figures: an earlier draft of this runbook said "about 44 action types",
  which mixed the code's literals with queue-row names; and the decision spec cited 1,042 rows,
  which this measurement did not reproduce. `audit_logs` cannot shrink short of a TRUNCATE, so the
  269 stands. The 20 types and 50 keys agree with the spec.
- (a) is verifiable by `count(*) = 0`. That is the whole argument.

**How it is built (migration 048):**
- A `NOLOGIN` role with no members, `chronixedu_audit_purger`, owns a `SECURITY DEFINER` function
  `chronixedu_purge.purge_school_audit_logs(school_id, operator_id)`.
- The DELETE trigger lets a delete through only when `current_user` is that role, which happens
  only inside the function. There is no session flag anyone could set.
- The function deletes that school's rows only: rows with its `school_id`, or by its users.
- Before deleting, it writes the record of the purge.
- It lives in a schema PostgREST does not expose. EXECUTE belongs to the table owner alone; PUBLIC,
  `anon`, `authenticated` and `service_role` are revoked.
- Content UPDATE and write-once `processed_at` (037/038) are untouched, each tested.

`platform_audit_logs` turned out to have no triggers at all. Only its foreign keys held a school
alive, so the script deletes it with a plain DELETE.

**The record of the purge** is the one row a run leaves on purpose: `platform_audit_logs`,
`SCHOOL_AUDIT_PURGED`, written before the delete, naming the operator. It holds the school id in
`metadata` and leaves `target_school_id` NULL. That breaks the loop of "who records the purge of
the purge log": the record has no foreign key to the school, so the school's deletion neither
blocks on it nor removes it, and it survives permanently. It holds a UUID and a count, no personal
data. Doctrine 6 still applies: the owner can still `DISABLE TRIGGER`. This path is
accident-proofing, and it is the only door that is not deliberate.

## Test record

**1 Oct 2026, local disposable database** (`chronixedu_test`, Docker, rebuilt from `migrations/`).

- `schoolDeletion.db.test.ts`, 18 tests, all pass:
  - completeness: every table classified, the tail is audit → users → school;
  - migration 048:
    - the purge removes A's audit rows and leaves B's 2 (checked non-empty first);
    - a plain DELETE as the owner is still refused;
    - a content UPDATE is still refused;
    - `processed_at` is still write-once;
    - the function is unreachable by `anon`/`authenticated`/`service_role`/PUBLIC, and no role has SET or INHERIT membership in the purger;
    - the purge refuses a null id, a non-super-admin operator, and a super admin inside the school;
    - `platform_audit_logs` has no triggers (pinned);
  - Storage listing: all 6 of A's files across both buckets, none of B's, not a look-alike path; a database without Storage reports "not checked", not zero;
  - dry run changes nothing and lists every email and phone number;
  - the real run leaves zero rows in every table, users and school row included;
  - the record of the purge survives;
  - not one school-B row is touched;
  - a refusal mid-transaction rolls everything back;
  - the operator is resolved by email;
  - a rerun finds nothing;
  - migration 047.
- `purgeDuringNotification.db.test.ts`: the school is purged from inside a real
  `processNotificationQueue()` run, between the worker reading its batch and stamping the row. The
  worker completes without throwing, and School B's row (queued after A's) is still processed.
- **Shown failing on the old code by reverting it** (old script from `58eca29`, 048 moved aside):
  11 of 18 fail, plus the worker test, each for the right reason ("schema chronixedu_purge does not
  exist", rows left behind, `resolveOperator` missing). The guard tests pass on the old code, as
  they must, because they protect what 048 must not change. So they were shown to bite with a
  mutation instead: a deliberately over-broad 048 (DELETE and content UPDATE opened, EXECUTE to
  PUBLIC, the owner made a member, a trigger added to `platform_audit_logs`) failed all five.
- **Found while doing that:** the DB suite's rebuild dropped only `public`, so 048's
  `chronixedu_purge` schema survived between local runs. The first "old code" run still had a stale
  purge function and measured leftovers. `jest.db.globalSetup.ts` now drops every schema a
  migration creates.
- **Migration 048 under production's role conditions.** Production's `postgres` is not a superuser
  (CREATEROLE + BYPASSRLS only), and locally it is, so the migration was also run as a
  non-superuser with those attributes, in a scratch database with 037's real triggers. The first
  attempt failed with "permission denied for schema chronixedu_purge": the purger needed USAGE to
  resolve its own function while setting grants. Fixed (granted for the migration, then revoked),
  and re-run clean, with every property above re-checked there.
- CLI on the seed's School A:
  - the dry run listed 15 tables, `audit_logs`, `platform_audit_logs`, `users` and `schools` included, plus 8 email addresses and 2 phone numbers;
  - refusals: no `--operator`, and an operator who is not a super admin;
  - `--execute --skip-supabase --operator …` committed with the in-transaction zero check;
  - the rerun, both dry and `--execute`, printed "Nothing to delete" and exited 0.
  - Earlier refusal checks (malformed id, `--confirm`, Supabase choice, credentials, hosts, sentinel key) were rerun under the current flag names the same day and still hold.
- Migration 047 (the component-weight trigger skips a config deleted in the same transaction) is in
  production since 30 Sep 2026, 23:43 UTC (`migration_runs` id 55).
- **Live trial on production:** done 1 Oct 2026, below. Every path in this runbook has now run for
  real; nothing is listed as unexercised.

## Live trial (production)

**1 Oct 2026, production** (Supabase `pgnpmqaowrnmsytpehwc`), after migration 048 was applied by
the pre-deploy step (`migration_runs` id 56, commit `93b5938`, 1 applied of 50).

**048 in production, checked before use:**
- the function is owned by `chronixedu_audit_purger`, is SECURITY DEFINER, and its ACL is the purger and `postgres` only;
- the role is NOLOGIN, NOINHERIT, BYPASSRLS, not a superuser;
- its only membership is Supabase's automatic ADMIN grant to `postgres` (no SET, no INHERIT);
- `anon`, `authenticated` and `service_role` cannot execute it; `anon` has no USAGE on the schema;
- the purger's migration-time CREATE is gone.

`DELETE FROM audit_logs WHERE false` was refused with the new HINT, because the trigger is
statement-level and fires even when nothing matches.

**The trial school** (`deletion-trial-20261001`, `is_demo = true` so it never counted as a customer):
- Set up with one Auth user, one logo in `school-assets`, one `audit_logs` row and one
  `platform_audit_logs` row. All of it was confirmed present by direct query before the run.
- **Dry run:** named the school; listed `audit_logs` 1, `platform_audit_logs` 1, `users` 1, `schools` 1;
  1 Auth account; 1 Storage file; 1 email address to clear from SendGrid.
- **Execute, first attempt: a real network failure.** The Auth delete failed with "other side
  closed" (0 bytes read back). The script stopped with "the database was NOT touched", and an
  independent query confirmed every row, the Auth user and the file still present, and no purge
  record. So the failure path has now run in production, not only locally.
- **Execute, rerun of the identical command:** Auth account and file deleted first, then the
  transaction committed with its in-transaction zero check. The service key appeared 0 times in
  either run's output.
- **Verified independently of the script** (`verify.js` in the session scratchpad, which does not
  use the script or its table list):
  - Auth admin API `getUserById` → "User not found (404)"; `auth.users`, `auth.identities` and
    `auth.sessions` all 0;
  - Storage API download → "Object not found (404)"; no `storage.objects` row names the school;
  - **every uuid/text column of every `public` table** (242 columns, 44 tables) scanned for the
    school id and the user id: 0 rows;
  - the purge record survives: `SCHOOL_AUDIT_PURGED`, operator `info@chronixtechnology.com`,
    `target_school_id` NULL, `audit_logs_deleted: 1`.
- **Confirming dry run:** "Nothing to delete … no row in any table refers to it", exit 0.

**The scanner's control (doctrine 16).** The same scan, run on `guyg ` before its deletion, found
its 4 rows (`onboarding_sessions`, `platform_audit_logs`, `school_settings`, `schools`), exactly
what the script's dry run listed. So a 0 from the scan means absent, not unscanned.

**`guyg `** (slug `guyg-24864a`) was then deleted the same way:
- dry run: 4 rows, 0 Auth accounts, 0 files;
- one email address and one phone number on the school row were printed for SendGrid/Termii (not
  reproduced here; this repository is public);
- execute committed; the independent scan found 0 rows; the purge record survives
  (`audit_logs_deleted: 0`); the confirming dry run said "Nothing to delete".

**After both:** 45 schools, all `is_demo`; 0 customers; 0 customer subscriptions; 2
`SCHOOL_AUDIT_PURGED` records. Measured by direct query.

## Known gaps

- **Files are not in the export.** The CSV export is complete for the database. Report cards can
  be regenerated, but student photos and assignment submissions exist only as files. The DPA's
  "CSV or PDF" is arguably met for records, not for uploads. Adding a file bundle is a feature;
  see `docs/AUDIT-2026-09.md`.
- **Termii** has no deletion route (table above). SendGrid suppressions are manual but covered by
  the procedure.
