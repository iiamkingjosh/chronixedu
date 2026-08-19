# Student & Parent Bulk Import — Design Spec

**Date:** 2026-08-19
**Status:** Approved for implementation planning

## Overview

Student registration today is one-at-a-time only: `POST /:schoolId/students` ([students.ts:152-223](apps/api/src/routes/students.ts#L152-L223)) takes a single student + up to N parent objects in one request body, driven by a one-student-per-submission form on the registrar's Students page. Onboarding a whole class (or migrating an entire existing school's roll) means repeating that form dozens to hundreds of times by hand.

This is the first of four approved bulk-import features (Students & Parents, Roster, Staff/Users, Fee Structures — decided in conversation, each gets its own spec). Students & Parents is built first because it has the highest manual-entry burden, and it establishes the upload → preview → commit pattern the other three will reuse.

**Scope of this spec:** registrar/principal/super_admin uploads a spreadsheet of students (each with up to two parents/guardians); the system shows exactly what will be created and what's wrong before anything is written; on confirmation, it creates the accounts using the exact same registration logic as the single-student form, and returns a downloadable record of what was created.

**Explicitly out of scope for this spec** (raised and deliberately deferred during design):
- Class enrollment via the import — imported students are created with no class; enrollment stays a manual per-student step in the existing UI.
- Background/async job processing — commit runs synchronously within the HTTP request, capped at 200 rows/file to keep that safe.
- Per-account random temp passwords — every bulk-imported account (student and parent) gets the fixed password `Password2$` instead (see Decisions Made).
- The other three approved bulk-import features (Roster, Staff/Users, Fee Structures) — separate specs, built after this one ships.

## Current State (reference)

- `registerStudent()` — [students.ts (queries) :91-207](apps/api/src/db/queries/students.ts#L91-L207) — the transactional core: generates `admission_no` (school+year+sequence), inserts the student's `users` row + `students` row, and for each parent either reuses an existing `users` row (matched by email) or creates a new one, linking via `parent_students`. This is reused as-is, called once per row.
- `POST /:schoolId/students` route — [students.ts:152-223](apps/api/src/routes/students.ts#L152-L223) — generates a random temp password per account (`randomBytes(8).toString('hex')`), calls `registerStudent()`, and fire-and-forget sends a welcome email to each *newly created* parent (`result.new_parents`) via `welcomeEmailBody('parent', ...)` and `sendEmail()`.
- Role gate — `requireRole('super_admin', 'principal', 'registrar')`, same on every students.ts write route. The bulk-import endpoints use the same gate.
- `registerSchema` / `parentSchema` — [students.ts:81-103](apps/api/src/routes/students.ts#L81-L103) — the exact field set and constraints the import must match: student `first_name`, `last_name` required; `email`, `phone`, `dob` (`YYYY-MM-DD`), `gender`, `address`, `blood_group`, `emergency_contact_name`, `emergency_contact_phone` all optional; parent `email`, `first_name`, `last_name`, `relationship_type` required *if a parent block is used at all*, `phone` and `is_primary_contact` optional.
- `must_change_password` — column added in `migrations/021_account_lockout.sql`, defaulted to `TRUE` for new rows by `migrations/026_expand_announcement_audience_and_password_flag.sql`. Login (`auth.ts`) already includes it in the JWT/response, and `apps/web/app/providers.tsx` already redirects any session with it set to `/change-password`. Bulk-imported accounts inherit this automatically since they're plain `INSERT`s with no explicit override — no new work needed to force a password change on first login.
- Batched email fan-out pattern — `announcements.ts:82-101` — `BATCH_SIZE = 50`, `Promise.all` per batch, 1-second delay between batches. Reused for welcome emails here instead of firing all of them at once.
- Existing multer pattern for file uploads — e.g. `apps/api/src/routes/students.ts:337` (`upload.single('photo')`), `apps/api/src/routes/schools.ts` (logo/signature/stamp) — same `multer({ storage: multer.memoryStorage(), limits: {...} })` shape is reused for the import file upload.
- No CSV/Excel parsing library exists in either `apps/api/package.json` or `apps/web/package.json` today (confirmed by inspection) — this spec introduces one (`exceljs`, already used ad hoc this session for generating `.xlsx` files, and capable of reading both `.xlsx` and CSV).

## Decisions Made

- **Two-step flow, not one-shot:** upload → server-side parse + validate → preview (nothing written yet) → user confirms → commit (writes). Preview and commit are separate endpoints; the frontend posts the *same validated row data* back to commit rather than re-uploading the file.
- **Server never trusts client-supplied row data at commit time** — commit re-runs the exact same validation the preview did, from scratch, against current DB state (matches the existing "never trust the client-confirmed name — re-resolve server-side" pattern in `schools.ts`'s payout PUT route). This guards against both tampering and staleness (e.g. a colliding email registered by someone else between preview and commit).
- **One DB transaction per row**, not one transaction for the whole file — a single bad/failing row must not roll back the other 199 good ones. Each row's outcome (created / failed + reason) is tracked independently and reported back.
- **File formats accepted:** both `.xlsx` and `.csv`. A branded downloadable `.xlsx` template (same visual style as the sample workbook already produced this session) is available on the import page.
- **Class enrollment is not part of this import** — deliberately deferred; imported students land with no class, same as if `class_id` were omitted on the single-registration form today.
- **Row cap: 200 per file**, enforced at parse time — keeps the synchronous commit request comfortably fast and avoids the kind of edge/gateway timeout behavior already observed in this project (Railway's proxy replacing slow/5xx responses with its own generic error page — see the Paystack `424` fix earlier this session). A school with more than 200 new students splits into multiple files. No background job queue in this version.
- **Fixed temp password for every bulk-imported account:** `Password2$`, not a random per-account password. This is an explicit, deliberate trade-off (not an oversight) — distributing one memorable password to hundreds of new parents/students is far more practical than distributing hundreds of unique strings, and the exposure window is bounded by the existing `must_change_password` forced-redirect flow already in production: every bulk-imported account is required to change its password the first time it's used. Because the password is no longer a per-row secret, the post-commit results file does **not** include a password column — it states the fixed password once, up top, alongside the list of created admission numbers / emails for the registrar's own records.
- **No inline row-editing in the preview.** Errors are reported per row with a specific reason; fixing a bad row means fixing the source file and re-uploading. Building a spreadsheet-like inline editor is out of scope — YAGNI for v1.
- **Roles:** identical to single registration — `super_admin`, `principal`, `registrar`. No new role gate.

## Behavior

### 1. Backend — file parsing

New module, e.g. `apps/api/src/services/bulkImportParser.ts` (or inline in the route — implementation plan decides), using `exceljs` to read both `.xlsx` (native) and `.csv` (exceljs supports CSV read/write too, avoiding a second parsing library).

Expected columns (order-independent, matched by header name, case-insensitive):

| Column | Required? |
|---|---|
| First Name | required |
| Last Name | required |
| Email | optional |
| Phone | optional |
| Date of Birth (YYYY-MM-DD) | optional |
| Gender | optional |
| Address | optional |
| Blood Group | optional |
| Emergency Contact Name | optional |
| Emergency Contact Phone | optional |
| Parent 1 First Name / Last Name / Email / Phone / Relationship / Primary Contact (Yes/No) | optional as a block; if any Parent 1 field is filled, Parent 1 Email becomes required |
| Parent 2 … (same six columns) | optional as a block, same rule |

### 2. Backend — validation (shared by preview and commit)

A single validation function, e.g. `validateBulkImportRow(row, context)`, called by both endpoints so the rules can never drift apart between preview and commit. Per row, checks:

- Required fields present (`first_name`, `last_name`).
- Email format valid where provided (student, Parent 1, Parent 2) — reuses the same Zod email validation as `registerSchema`/`parentSchema`.
- `dob` matches `YYYY-MM-DD` if present (reuses `datePattern` from `students.ts:79`).
- A parent block with some fields filled but no email → error on that row.
- An email (student or either parent) that already belongs to a `users` row of a **different role** in this school → error (conflict), not a silent merge. (An email belonging to the *same* role — i.e. an existing parent being reused across siblings — is expected and fine, exactly like single registration today.)
- Duplicate rows within the same file (same student first/last/email combination appearing twice) → error on the second occurrence.

Each row's result: `{ row_number, student: {...}, parents: [...], status: 'valid' | 'error', errors: string[] }`.

### 3. Backend — endpoints

```
POST /:schoolId/students/bulk-import/preview
  verifyToken, requireSchoolAccess, requireRole('super_admin','principal','registrar')
  multer upload.single('file'), limits: { fileSize: 5 * 1024 * 1024 } // 5MB
  → parses file, enforces 200-row cap (reject with a clear error above that),
    runs validateBulkImportRow() on every row
  → 200 { success: true, data: { rows: [...], summary: { total, valid, invalid } } }
  Writes nothing.

POST /:schoolId/students/bulk-import/commit
  verifyToken, requireSchoolAccess, requireRole('super_admin','principal','registrar')
  body: { rows: [...] }  // exactly the "valid" rows as returned by preview
  → re-runs validateBulkImportRow() on every row against current DB state
  → for each still-valid row: hashSync('Password2$', 12) for student + each new parent,
    call registerStudent() in its own transaction (identical to the single-registration
    route, just looped)
  → collects new parents across the whole batch, sends welcome emails in batches of 50
    with a 1s gap (reusing the announcements.ts pattern), fire-and-forget
  → 200 { success: true, data: { created: N, failed: N, results: [...], download: <xlsx> } }
```

The `download` result is generated in-memory (`exceljs`) and returned as part of the response for the frontend to save — never persisted server-side, matching the existing "shown once" principle for credentials.

### 4. Frontend

New page/section under the Registrar → Students area (exact route decided in the implementation plan, e.g. `/registrar/students/import`):

1. **Upload step** — file picker (`.xlsx`/`.csv`), a "Download template" link/button producing the branded sample workbook, calls the preview endpoint on submit.
2. **Preview step** — table of every row: row number, student name, parent(s) summary, status badge (green "Will create" / red "Error: <reason>"). Summary line ("187 of 190 rows valid"). "Import N valid students" button, disabled if 0 valid rows.
3. **Commit + results step** — calls the commit endpoint with the valid rows, shows the final "N created, N failed" summary with per-row detail for any failures, and a "Download results" button producing the `.xlsx` file described above (admission numbers, emails, the one-line fixed-password note).

### 5. Testing

- Unit tests for `validateBulkImportRow()` and the file parser: well-formed rows, missing required fields, malformed email/date, parent block without email, duplicate rows in one file, cross-role email conflict, both `.xlsx` and `.csv` input.
- Integration tests (real test DB, matching `apps/api/tests/*.test.ts` conventions) for both endpoints: preview writes nothing; commit creates the right rows and reuses existing parents by email; a deliberately-bad row in an otherwise-good batch doesn't block or roll back the others; the 200-row cap is enforced; role gating matches single registration (teacher/bursar/parent/student all rejected).
- Manual end-to-end pass using the already-generated branded sample template before calling the feature done.
