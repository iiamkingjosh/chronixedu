# Data deletion runbook: one school, on termination

**What we promised.** DPA §11 and Terms §22 (both accepted by schools; `legal_terms_accepted_at`,
do not edit):

> On termination of the Service, the School has thirty (30) days to request a complete export of
> its data in a portable format (CSV or PDF). Chronix Edu will permanently delete the School's
> Personal Data from its systems and those of its Sub-processors within ninety (90) days of
> subscription termination, except where retention is required by applicable law.

This document is the process that keeps that promise. It has been run end to end on a disposable
school ([Test record](#test-record)). **One part of it cannot be completed yet**: the audit log.
Read [The decision](#the-decision-moses) before the first real deletion.

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
2. **Dry run** (changes nothing, prints the plan), from a machine with the production env:
   ```bash
   DATABASE_URL=<production pooler url> \
   node apps/api/scripts/delete-school-data.js --school <school-uuid> --allow-host <db host>
   ```
   Check the school name and slug it prints. Keep the output.
3. **Execute:**
   ```bash
   DATABASE_URL=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
   node apps/api/scripts/delete-school-data.js --school <uuid> --allow-host <db host> \
     --execute --confirm <school-slug> --with-supabase
   ```
   Guards, each tested: refuses a non-local database unless `--allow-host` equals the URL's host;
   refuses `--execute` without `--confirm <slug>`; refuses `--execute` without exactly one of
   `--with-supabase` / `--skip-supabase`; refuses `--with-supabase` without credentials. Every
   refusal says "Nothing was changed." The service key is never printed (checked with a sentinel).
   Order: Supabase Auth accounts and Storage files first, stopping if any fails; then **one
   database transaction**, children before parents. Rerunning is safe.
4. **Sub-processors.** Work through the table below and note each outcome in the ticket.
5. **Confirm.** A second dry run should list nothing to delete except what the audit rule keeps.

## Every system that holds school data

| System | What it holds for a school | How it is deleted | Status |
|---|---|---|---|
| **Supabase Postgres** (`public`) | Every table. The export covers all of them; `schoolExport.db.test.ts` fails if a new table is not classified. | The script, in one transaction. `schoolDeletion.db.test.ts` fails if a new table is in neither `STEPS` nor `NOT_DELETED`. | ✅ except `audit_logs`, `platform_audit_logs`, the users those name, and the school row. See [The decision](#the-decision-moses). |
| **Supabase Auth** | One account per user: email, password hash; `identities` and `sessions` cascade. `auth.audit_log_entries` is empty in production (checked 1 Oct 2026), so login history is not kept in the database. | The script, `--with-supabase` (the same `auth.admin.deleteUser` the super-admin screen uses). Every Auth user has a `public.users` row (checked), so the script sees them all. | ✅ |
| **Supabase Storage** | `school-assets/schools/<id>/…` (logo, signature, stamp, student photos, staff signatures, assignment files) and `report-cards/{<id>, receipts/<id>, transcripts/<id>}/…`. All 15 production files match these four prefixes (checked 1 Oct 2026). | The script, `--with-supabase`, through the Storage API (a row delete would leave the file), then re-listed to prove it is empty. | ✅. **3 orphaned files exist today**: `school-assets` files for schools already wiped by `seed-child-prime.js`, which deletes schools but not their files. Clean up with `--skip-supabase` output or by hand. |
| **Supabase backups** | Production is on the **free plan**. Supabase backs up Pro/Team/Enterprise daily (7/14/30 days); for free projects it "currently" takes up to 7 daily backups, reachable only after upgrading, and "might no longer" do so. | Not deletable; they expire. At most 7 days, well inside 90. | ✅ by expiry. **[MOSES]**: Terms §19 says "we perform routine backups". On the free plan that is not something we control. Upgrading to Pro ($25/mo) makes it true. |
| **Supabase logs** (API/Postgres log explorer) | Request metadata; no bodies. | Expire by plan (free: 1 day). | ✅ by expiry |
| **Railway logs** | API logs. Personal data appears only on email-send failure (`sendgrid_email_failed`, `email_queue_retry_failed` log the recipient address). | No per-record deletion. Retention by plan: Free 3 d, Trial/Hobby 7 d, Pro 30 d, Enterprise up to 90 d. | ✅ by expiry on any plan. **[MOSES]** confirm the plan (the API does not expose it). |
| **Sentry** | Error events and session replays. As of this change: user **id** only (the email was being sent until now; see `middleware/auth.ts`), and replays mask all text and inputs and block media, stated explicitly in `sentry.client.config.ts`. Events from before this change carry emails. | Events expire by plan retention (30–90 days depending on plan). | ✅ by expiry. Older events with emails age out within that window of this deploy. **[MOSES]** confirm the Sentry plan's retention. |
| **SendGrid** | Email Activity (recipient, subject, status) and suppression lists (bounces, blocks, spam reports, unsubscribes), which **do not expire**. | Activity expires (3 days by default, 30 with the extended-history add-on). Suppressions: delete each of the school's addresses via Suppressions in the dashboard or `DELETE /v3/suppression/{bounces,blocks,spam_reports,unsubscribes}/{email}`. | **[MOSES]** verify retention in the dashboard. Suppressions are a manual step: take the addresses from the school's `people` export *before* executing. |
| **Termii** | SMS history: parent phone numbers and message text (attendance alerts). | Unknown. No deletion API we use. | **[MOSES]** ask Termii how long message logs are kept and how to request deletion. |
| **Paystack** | Transactions for school-fee payments: payer email, amount, reference. | Merchants cannot delete transactions; Paystack keeps them under its own regulatory obligations. | Legal-retention exception, by Paystack's obligation not ours. **[MOSES]** confirm with the adviser. |
| **Opay** | Named in the DPA; **no integration exists in the code** (grep). | Nothing to delete. | ✅. [MOSES] the DPA lists a sub-processor we do not use; harmless, but worth tidying at the next legal revision. |
| **Cloudflare** | Named in the DPA as CDN; configured outside this repo. | Request logs, if any, expire by plan. | **[MOSES]** confirm whether Cloudflare is in front of the domain today. |

## The decision [MOSES]

`audit_logs` is append-only **for every caller**: migration 036 blocks DELETE, 037 blocks content
UPDATE (only `processed_at` may be written, once). It has foreign keys to `users` and `schools`. So
after the script runs, three things remain:

- the school's audit rows: about 44 action types, whose JSON can hold names, emails, scores,
  payment amounts and IP addresses;
- the `users` rows those audit rows name (email, name);
- the `schools` row.

`platform_audit_logs` (Chronix's record of its own admins' actions) is kept alongside, for the
same reason. In the test, 1 audit row kept 1 user and the school row. A real school would keep
every staff member who ever saved anything.

The spec offered two routes. **Both need a migration that relaxes the audit trigger**, because
anonymising is an UPDATE and 037 blocks it as surely as 036 blocks DELETE:

| | (a) Delete: a named purge path | (b) Anonymise in place |
|---|---|---|
| What changes | A migration lets DELETE through for one school's rows, only via a purge function that records itself in `platform_audit_logs`. Then the users and school rows can go too. | A migration lets UPDATE through, via a scrub function, to rewrite JSON, `ip_address`, and the users/school rows (`email → deleted-<id>@invalid`, names nulled). |
| Meets "permanently delete" | Yes, literally. | Only if the scrub is complete. It must know every key in all ~44 JSON shapes, now and in future, and a missed key is personal data we claim to have deleted. |
| What is lost | The evidence trail of that school's activity, e.g. for a dispute raised after deletion. | Little; structure and timing survive. |
| Cost | Small: one function, one test. | Larger: the function plus a per-action scrubber, and a ratchet that fails when a new action type appears. |
| Weakens the audit rule | Yes: there is now a sanctioned way to delete. Doctrine 6 already says the rule is accident-proofing, not tamper-proofing, and a purge that audits itself fits that. | Yes, and more broadly: UPDATE of content becomes possible. |

Also possible: **(c) keep audit rows as-is**, if the adviser says the law requires them. That is
the DPA's "except where retention is required by applicable law", and it is what the script does
today by default.

My read, for what it's worth: (b) costs more and delivers less, because it needs the same
relaxation plus a scrubber that must never miss a key. If the legal answer is "delete", (a) is the
honest implementation; if it is "retain", (c) needs no code. **Nothing has been chosen.** This is
yours to take to whoever advises you on NDPR. The script reports what it kept on every run, so no
deletion can silently claim to be complete.

## Test record

**1 Oct 2026, local disposable database** (`chronixedu_test`, Docker, rebuilt from `migrations/`).

- `schoolDeletion.db.test.ts`, 9 tests, all pass:
  - completeness: every table classified;
  - Storage listing: all 6 of A's files across both buckets, none of B's, not a look-alike path;
  - no-Storage database: reports "not checked", not zero;
  - dry run changes nothing;
  - execute: every school-A row gone except the audit-protected ones;
  - not one school-B row touched;
  - with no audit rows, the school row goes too;
  - migration 047 (below);
  - rerun finds nothing.
- CLI, School A of the seed:
  - dry run listed 12 tables (e.g. 3 students, 3 enrolments, 6 users, 1 queued email), 7 Auth accounts and "1 audit_logs row, 1 audited user, the school row" kept;
  - refusals verified: no `--confirm`, wrong slug, no Supabase choice, both choices, missing credentials, remote host, wrong `--allow-host`;
  - Auth unreachable: all 7 deletions failed, the script stopped with "the database was NOT touched", and a dry run afterwards showed every row still present;
  - `--execute --skip-supabase` committed, printed the 7 Auth ids, and kept the school row (still referenced);
  - a second dry run listed nothing to delete.
- **Found by the test, fixed:** deleting a config's assessment components failed at COMMIT
  ("must equal 100; got 0"). The weight trigger re-checked configs that the same transaction had
  deleted. Migration 047 skips a config that no longer exists. Emptying or unbalancing a config
  that still exists is still refused (tested both).
- **Not yet exercised:** `--with-supabase` against a live Supabase Auth/Storage. Only its failure
  path ran locally. **[MOSES]** Before the first real deletion, create a throwaway school in
  production, give it one user and one logo, and run the script on it with `--with-supabase`. That
  is the one step left before this is proven end to end.

## Known gaps

- **Audit log**: see [The decision](#the-decision-moses).
- **Files are not in the export.** The CSV export is complete for the database. Report cards can
  be regenerated, but student photos and assignment submissions exist only as files. The DPA's
  "CSV or PDF" is arguably met for records, not for uploads. Adding a file bundle is a feature;
  see `docs/AUDIT-2026-09.md`.
- **SendGrid suppressions and Termii** are manual or unknown (table above).
