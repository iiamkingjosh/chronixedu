# Staff/Users Bulk Import — Design

## Overview

A principal or super_admin can upload a single flat spreadsheet (`.xlsx` or `.csv`) of staff members — teachers, registrars, bursars, and principals — and create their accounts in bulk, instead of using the "Add User" form one person at a time. This is the 3rd of 4 approved bulk-import features (after Students & Parents, Roster), following the same two-step preview/commit pattern established by both.

The one real architectural difference from the earlier two features: creating a staff account requires a call to **Supabase Auth's admin API** (`supabaseAdmin.auth.admin.createUser`) in addition to the local `users` table insert — an external network call per row, not just a Postgres write. This shapes several decisions below (row cap, per-row error handling).

## Scope

**In scope:** creating `teacher`, `registrar`, `bursar`, and `principal` accounts in bulk.

**Out of scope:**
- `parent` and `student` roles — already covered by the Students & Parents bulk import (parent accounts are created there as a side effect of student creation).
- `super_admin` — platform-level accounts are created through a separate `/auth/create-user` flow, never through a school's staff management. The existing single-item `POST /:schoolId/users` route already blocks this explicitly; the bulk import inherits the same block.
- Editing or deactivating existing staff in bulk — this feature only creates new accounts.

## File Format

`.xlsx` or `.csv`, one flat sheet — matching Students & Parents (unlike Roster, which needed 3 sheets and was forced to `.xlsx`-only; a single flat table has no such constraint).

## Columns

| Column | Required | Notes |
|---|---|---|
| `Email` | Yes | Must be a valid email address. Lowercased on parse. Must be unique **platform-wide** (the `users.email` column has a global UNIQUE constraint — not scoped per school), both against existing accounts and against other rows in the same file. |
| `First Name` | Yes | Max 255 characters, matching `createUserSchema`. |
| `Last Name` | Yes | Max 255 characters. |
| `Role` | Yes | One of `teacher`, `registrar`, `bursar`, `principal` (case-insensitive match, normalized to lowercase). Any other value (including `parent`, `student`, `super_admin`) is a validation error. |
| `Title` | No | Max 20 characters (e.g. "Mr.", "Mrs.", "Dr."). |
| `Phone` | No | Max 50 characters. |
| `Teaching Mode` | Required only if Role is `teacher` | `class` or `subject`. Ignored (and must be blank) for all other roles — a non-teacher row with a Teaching Mode value is a validation error, matching the single-item form's mutual exclusivity. |

## Validation Rules

Per-row checks (mirroring `createUserSchema` exactly):
- All required fields present.
- Field length limits as above.
- Valid email format.
- Role is one of the four allowed values.
- Teaching Mode present and valid (`class`/`subject`) if and only if Role is `teacher`.

Cross-row / cross-database checks:
- **Duplicate email within the file**: two rows with the same email (case-insensitive) — both flagged as errors, matching the "flag both, don't silently pick one" pattern from Students & Parents.
- **Duplicate email against existing accounts**: checked via a new batched query, `findUsersByEmails(emails: string[]): Promise<Set<string>>` — platform-wide, not school-scoped, since email uniqueness is global. One query for the whole file, not one query per row.

No cross-referencing against other sheets is needed (unlike Roster) — this is a single flat table.

## Endpoints

**`POST /:schoolId/staff-bulk-import/preview`**
- Auth: `super_admin`, `principal` only (matches the existing single-item `POST /:schoolId/users` route's gate exactly — tighter than Students & Parents, which also allows `registrar`).
- Parses the uploaded file, runs full validation (including the duplicate-email checks above), returns per-row results. **Writes nothing** — no Supabase Auth calls, no DB writes. Row cap: 50 — see Row Cap below for the reasoning.
- Magic-byte validation via `file-type` before parsing (matches Students & Parents' upload security check).

**`POST /:schoolId/staff-bulk-import/commit`**
- Same auth gate.
- Re-validates every row from scratch against a fresh snapshot of existing accounts — never trusts the client-supplied `status` field from preview.
- For each valid row, in order:
  1. Call `supabaseAdmin.auth.admin.createUser({ email, password: 'Password2$', email_confirm: true, user_metadata: {...} })`.
  2. On success, call `insertUser(...)` to create the local `users` row (password_hash = bcrypt hash of `Password2$`, `teacher_mode` defaulted to `'subject'` for non-teacher roles, matching the single-item route).
  3. On success, write an audit log entry (`USER_CREATE`), matching the single-item route.
- Each row wrapped in its own try/catch — one row's failure (at either step 1 or step 2) does not stop the rest of the batch.
- Returns per-row created/failed status plus a downloadable `.xlsx` results file (columns: row #, email, first name, last name, role, status, reason-if-failed) — no temp-password column, since every account shares the same fixed password (communicated once in the UI, not per row).

## Row Cap

Students & Parents started with a 200-row cap that turned out, on measurement, to take ~9 minutes for a full synchronous batch (~2.7s/row) — it was lowered to 50 after the final review caught this. Staff bulk import has the same synchronous-HTTP-request architecture, but an added unknown: `supabaseAdmin.auth.admin.createUser` is a call to an external service (Supabase Auth), not just a local Postgres round-trip, so its per-row latency is not yet known and could be slower or faster than `registerStudent()`'s DB-only cost.

Rather than guess, this spec sets a conservative starting cap of **50 rows** (matching Students & Parents' final, measured value) and requires the implementation plan to include a real timing measurement task — if 50 rows takes meaningfully longer than Students' ~2.5 minutes, the cap gets lowered before shipping, the same way Students' did.

## Temp Password

Every bulk-created account gets the fixed password `Password2$` (matching the platform-wide policy set for Students & Parents and Roster). This relies on the existing `must_change_password` column defaulting to `TRUE` on insert (already true for every account creation path in this codebase, including the single-item staff route) — no new code is needed to force a reset on first login. The frontend states this once ("All accounts created with temp password: Password2$"), not per row.

## Accepted Risk: Orphaned Supabase Auth Accounts

If `supabaseAdmin.auth.admin.createUser` succeeds but the subsequent local `insertUser()` call then fails (e.g. an unexpected DB error), the result is a Supabase Auth account with no matching local `users` row — an orphaned auth identity that can't actually log into the app (the app's login flow depends on the local row) but exists in Supabase's user list.

This is **not a new risk introduced by bulk import** — the existing single-item `POST /:schoolId/users` route has the exact same two-call sequence with no rollback of the Auth account on DB failure. Bulk import inherits this exactly as-is, just at higher row volume. Fixing it (e.g. wrapping both calls in a compensating-transaction pattern) is out of scope for this feature, consistent with how the Students & Parents plan flagged the pre-existing `admission_no` global-uniqueness bug as out-of-scope rather than fixing it as a side effect.

## Testing

- Unit tests for the parser (column matching, blank-row skipping, role normalization, email lowercasing).
- Unit tests for validation (required fields, role enum, teacher_mode mutual-exclusivity, duplicate detection within-file and against a mocked existing-accounts set).
- Integration tests for both endpoints against a real test school, including: role-gate rejection (registrar/teacher tokens get 403), a successful create, a duplicate-email rejection, and a partial-failure commit (one row succeeds, one fails, batch continues).
- A real end-to-end timing measurement at the chosen row cap, to confirm the synchronous request completes in an acceptable window — the basis for either keeping or lowering the 50-row starting cap.

## Decisions Made

1. **Role scope**: staff roles only (`teacher`, `registrar`, `bursar`, `principal`) — not `parent`/`student` (owned by Students & Parents) or `super_admin` (separate platform flow).
2. **Temp password**: fixed `Password2$` for every account, matching the platform-wide bulk-import policy.
3. **File format**: `.xlsx` and `.csv` both accepted — a single flat table has no multi-sheet constraint forcing `.xlsx`-only.
4. **Role gate**: `super_admin`/`principal` only, matching the existing single-item staff-creation route exactly (tighter than Students & Parents, which also allows `registrar`).
5. **Row cap**: 50 rows to start (matching Students & Parents' measured final value), pending real-world timing measurement of the Supabase Auth API call during implementation.
