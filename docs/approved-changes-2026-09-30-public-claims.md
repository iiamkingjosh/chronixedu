# Public claims and the retention commitment: approved spec and how it landed

Status: approved by Moses 30 Sep 2026. **All five sections implemented in `58eca29` (deployed
30 Sep, 23:43 UTC), except the (a)/(b) decision in §1, which is [MOSES] by the spec's own
instruction.** Records: SECURITY.md Round 21; `docs/AUDIT-2026-09.md` (the claims resolved, the
open deletion item); `docs/data-deletion-runbook.md`; `docs/CHANGELOG.md`; CLAUDE.md "A school's
data: export and deletion".

| § | Asked | Landed |
|---|---|---|
| 5 | Say what the carve-out test asserts; make it assert a payment route cannot exist outside the carve-out | It asserted the list was empty, passing whatever routes existed. Replaced by `carveOut.test.ts`, which walks every write route mounted behind the guard. The contract is the payment path segments `platform-billing`, `subscription`, `renew` and `checkout`. A payment route named otherwise escapes the test; CLAUDE.md says so. |
| 3 | Reword "monitored around the clock"; claim no alerting that does not exist | "Monitored": error monitoring and uptime checks on the app and API. |
| 4 | Copy to match the code (3 absences in 7 days) | "absent three times in a week". |
| 2 | Reword isolation to what is true; note in the C-4a docs to restore it | Per-request check and per-query scoping, tested on every change. `docs/c4a/README.md`, "When C-4a lands". |
| 1b | School-facing export (recommended); confirm completeness | Principal → Settings → Data Export: 30 CSV datasets, audited, works while read-only. Completeness is a ratchet test over every table. **Gap:** stored files (photos, submissions, report-card PDFs) are not in it. |
| 1 | Runbook + dry-run-by-default script with a database guard; test on a disposable school; report (a)/(b), do not choose | Done. Tested locally on the seed's School A (runbook "Test record"). (a)/(b) reported in the runbook, **not chosen**. |

**Deviations and additions, each recorded where it belongs:**
- **(b) is blocked too.** The spec presents anonymising as the route that "preserves the audit
  invariant". It does not: migration 037 blocks content UPDATE, so (b) needs the trigger relaxed as
  much as (a) does. Runbook, "The decision".
- **The quote attributed to CLAUDE.md** ("a genuine retention/NDPR need must drop the trigger in
  its own migration…") is not in CLAUDE.md. The sentiment is in the HINT messages of migrations
  036 and 037: "If a retention or erasure policy genuinely requires this, drop trigger … in its own
  migration so the decision is recorded." So (a) is the sanctioned route as the spec says, by the
  migrations' own words.
- **Migration 047, not asked for.** The script's test showed no school could ever be deleted: the
  component-weight trigger re-checked configs deleted in the same transaction. 047 skips configs
  that no longer exist.
- **Supabase Storage**, missing from the spec's system table, holds every uploaded file. The script
  deletes it through the Storage API, together with Auth, before the database step. The flag is
  `--with-supabase`/`--skip-supabase` and is required with `--execute`.
- **Sentry**, missing from the spec's table but named in the DPA as "technical data only", was
  receiving every user's email. Fixed (SECURITY.md Round 21 M-01).
- **§3 went one claim further.** "Automated backups" was also removed: production is on Supabase's
  free plan, which Supabase does not commit to back up. Terms §19 still says "routine backups" and
  was left alone as a legal page. [MOSES]
- **The homepage's "delete our copy within 90 days"** is the same promise as §1, so it was left
  unchanged under §1's "do not change the words".
- **Paystack** went into the runbook as the legal-retention exception, as the spec expected, and
  **Opay** (named in the DPA) has no integration in the code.

The spec as approved follows, verbatim.

---

# Public claims and the retention commitment — spec

Approved by Moses, 30 Sep 2026, following the four claims reported after the plans work.

Severity order: §1 is a contractual exposure, §2 is a security claim, §3–4 are copy.
Nothing here is urgent tonight; §1 is urgent this week.

Scan basis: `legal/data-processing-agreement/page.tsx`, `legal/terms/page.tsx`,
`superAdmin.ts`, `home-page.tsx`, migrations 001 / 036 / 037, CLAUDE.md doctrine 6.

---

## 1. The 90-day deletion promise — build the process, do not change the words

**Why the words can't change.** The promise appears in two contractual documents, not
marketing copy:

- `legal/data-processing-agreement/page.tsx:88` — the DPA, the NDPR-mandated processor
  contract with each school
- `legal/terms/page.tsx:161` — Terms of Service §22

Both commit to: a **complete export in CSV or PDF within 30 days** of termination, and
**permanent deletion from Chronix's systems and those of its sub-processors within 90
days**, except where retention is required by law.

`schools.legal_terms_accepted_at` exists, so schools have **accepted** these terms.
Rewording them is a re-consent exercise, not an edit. Do not touch the legal pages.

**The architectural collision, which is the real work here.** Doctrine 6 and migrations
036/037 make `audit_logs` append-only for every caller including the table owner, and
`audit_logs` holds foreign keys to both `users` and `schools`. CLAUDE.md already records
the consequence for tests: an audited user or their school **cannot be deleted**.

The same wall stands in front of the deletion promise. So decide, and write the decision
down:

- **(a) Drop the audit trigger in a dedicated migration to permit the deletion.**
  CLAUDE.md explicitly contemplates exactly this: "a genuine retention/NDPR need must drop
  the trigger in its own migration rather than deleting rows ad hoc." This is the
  sanctioned route.
- **(b) Anonymise rather than delete** — scrub every field that identifies a person,
  keep the audit skeleton. This may satisfy NDPR while preserving the audit invariant,
  but whether it satisfies "permanently delete" as the DPA words it is a legal question,
  not an engineering one. If this route is preferred, say so and stop — Moses takes it to
  whoever advises him on NDPR.

Do not choose between them silently. Report the trade-off and let Moses decide.

**What to produce** (not a feature — a runbook plus a script):

`docs/data-deletion-runbook.md`, covering every system that holds a school's data:

| System | Holds | Deletion route |
|---|---|---|
| Supabase Postgres | all school data | script, subject to the decision above |
| Supabase Auth | user accounts | separate from the Postgres rows — easy to miss |
| Railway | request logs | retention window, and whether it is configurable |
| SendGrid | email activity, contacts | |
| Termii | SMS logs | |
| Paystack | payment records | **almost certainly the "required by applicable law" carve-out** — Nigerian financial-record retention. Document it as an exception rather than pretending it is deleted. |

The script takes one `school_id`, is dry-run by default, prints what it would remove, and
requires an explicit flag to act. It must refuse to run against anything but the intended
database — reuse the guard pattern the test runners already use.

**Test it on a disposable school before it is ever needed**, and record the result in the
runbook. An untested deletion procedure is the same as none, and the day it matters is
the worst day to discover that.

---

## 1b. The export half of the same promise — and a correction to the earlier spec

`GET /schools/:schoolId/export` exists but is on **`superAdmin.ts:815`** — super-admin
only. A school cannot export its own data; only Chronix can, on its behalf.

For the DPA that is arguably satisfiable, since it says the School may *request* an
export. Confirm the export is actually **complete** — if it omits any table a school would
consider theirs, the promise isn't met by it.

**But it invalidates a line in `plans-and-trial-gate-spec.md` §5**, which said read-only
means a school can "see and export everything." That was wrong — my error, not an
implementation gap. Either:

- add a school-facing export (principal role) and keep the read-only wording, or
- change the read-only notice to say data is visible and available on request.

Recommend the first: a school in read-only is a school deciding whether to renew, and
"your data is hostage until you ask us for it" is the wrong message at that moment.

---

## 2. "Isolated at the database level" — reword now, earn it back later

False today. The API pool connects as table owner and bypasses RLS (doctrine 2);
isolation lives in route guards and `WHERE school_id`. It is a security claim sitting in
front of schools evaluating you on data protection.

**Two steps, in this order:**

1. **Now:** reword to what is already true. Something in the shape of "every request is
   scoped to your school — no school can read another's data." True, verifiable, still
   strong. Do not weaken it into vagueness; state the real property.
2. **Later:** apply C-4a (`docs/c4a/grants.sql`, fully specified and probed, unapplied).
   Once the app connects as a restricted role and RLS is enforcing, the original sentence
   becomes true and can go back. Note that in the C-4a notes so the copy change is
   remembered when the work lands.

---

## 3. "Monitored around the clock" — reword

The uptime monitor read down for three months (wrong URL, fixed 30 Sep) and Redis
unavailability is logged at `error` but alarmed to nobody — recorded as an open item in
`docs/AUDIT-2026-09.md`.

Reword to what is true: uptime monitoring on the API and the app. Do not claim alerting
that does not exist. When the Redis alarm is built, the claim can grow.

---

## 4. "Absent three days running" — fix the copy

The code alerts on **three absences within seven days**, which is the better rule —
a child absent Monday, Wednesday and Friday matters as much as three consecutive days.
Change the copy to match the code, not the other way round.

---

## 5. Question outstanding from the read-only work

The payment-route carve-out is currently empty and reported as "pinned by a test." State
what that test asserts. If it asserts the list is empty, it passes trivially and forever
and proves nothing. What it must assert is that a payment route **cannot exist outside the
carve-out** — otherwise the payment system adds its routes, read-only blocks them, and a
lapsed school cannot pay to restore access. Doctrine 16, on a mechanism that only bites
once, at the worst moment.

---

## Order

1. §5 — answer the question; it is one file read
2. §3, §4 — copy fixes, minutes
3. §2 step 1 — copy fix
4. §1b — decide export vs wording, implement
5. §1 — the runbook and script, reporting the (a)/(b) trade-off before choosing

Full Definition of done. Document per the standing instruction. Tag anything needing
Moses with `[MOSES]` — at minimum the (a)/(b) decision in §1.
