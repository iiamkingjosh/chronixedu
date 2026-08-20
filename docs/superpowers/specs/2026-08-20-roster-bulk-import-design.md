# Roster Bulk Import — Design Spec

**Date:** 2026-08-20
**Status:** Approved for implementation planning

## Overview

Roster setup — Classes, Subjects, and Teacher Assignments — is currently one-record-at-a-time only, via three separate forms on the Settings > Roster page (`apps/api/src/routes/roster.ts`: `POST /:schoolId/classes`, `POST /:schoolId/subjects`, `POST /:schoolId/teacher-assignments`). Standing up a new school's whole academic structure means dozens of individual form submissions.

This is the second of four approved bulk-import features (Students & Parents — shipped — then Roster, then Staff/Users, then Fee Structures). It reuses the upload → preview → commit pattern the Students & Parents feature established, adapted for Roster's different shape: three related sub-resources in one file instead of one resource type.

**Scope of this spec:** principal/super_admin uploads a single `.xlsx` workbook with three sheets — Classes, Subjects, Teacher Assignments — previews exactly what will be created and what's wrong per row across all three sheets, then confirms to commit. Teacher Assignment rows resolve against **pre-existing** data only (see Decisions Made) — they are not aware of classes/subjects created earlier in the same commit.

**Explicitly out of scope for this spec:**
- Assignments referencing classes/subjects newly created in the same file — deliberately deferred; a school doing a from-scratch setup imports Classes+Subjects first, then does a second import for Assignments once those exist.
- Any change to the existing single-item Roster routes or the Roster settings page — this is purely additive.
- The other two remaining bulk-import features (Staff/Users, Fee Structures) — separate specs.

## Current State (reference)

- `classSchema` — [roster.ts:20-25](apps/api/src/routes/roster.ts#L20-L25) — `name` (1-255, required), `level` (1-100, required), `stream` (optional, max 100), `form_teacher_id` (optional UUID). Duplicate check is by exact `name` match within the school (`findClassByName`, [roster.ts:83-86](apps/api/src/routes/roster.ts#L83-L86)). `form_teacher_id`, if given, must resolve to an existing user with role `teacher` in the same school (`validateFormTeacher`, [roster.ts:29-36](apps/api/src/routes/roster.ts#L29-L36)).
- `subjectSchema` — [roster.ts:38-41](apps/api/src/routes/roster.ts#L38-L41) — `name` (1-255, required), `code` (1-20, required, **uppercased** before storage — [roster.ts:203](apps/api/src/routes/roster.ts#L203)). Duplicate check is by uppercased `code` within the school (`findSubjectByCode`).
- `assignmentSchema` — [roster.ts:43-47](apps/api/src/routes/roster.ts#L43-L47) — `teacher_id`, `class_id`, `subject_id` (all UUIDs in the single-create form; the bulk import resolves these from human-readable columns instead, see Behavior). Creating an assignment requires an active term (`getActiveTerm`, [roster.ts:320-323](apps/api/src/routes/roster.ts#L320-L323) — returns `422 NO_ACTIVE_TERM` if none), rejects a duplicate teacher+class+subject+term combination (`findDuplicateAssignment`), and requires the teacher to actually have role `teacher` (`findUserById` + role check, [roster.ts:330-333](apps/api/src/routes/roster.ts#L330-L333)).
- Role gate on every write route in `roster.ts`: `requireRole('super_admin', 'principal')` — **registrar is not included**, unlike the Students & Parents import.
- `findUserByEmail(email)` — `apps/api/src/db/queries/users.ts` — existing, platform-wide (not school-scoped) lookup by email, reused as-is for resolving a Teacher Assignment row's teacher.
- `listClasses(schoolId)` / `listActiveSubjects(schoolId)` — `apps/api/src/db/queries/roster.ts:52-61,109-118` — existing school-scoped list queries, reused for batch-resolving Class/Subject references without one query per row.
- The Students & Parents bulk import's `findUsersRolesByEmails()` (`apps/api/src/db/queries/students.ts`) is **not** reused directly here — it returns only `email → role` (platform-wide, any role), which is enough to detect a conflict but not enough to actually resolve a teacher reference, since Roster needs the matched user's **id** to store as `form_teacher_id`/`teacher_id`, scoped to *this school's* `teacher`-role users specifically. This spec introduces a new, purpose-built `findTeachersByEmails(schoolId, emails): Promise<Map<string, { id: string }>>` in `apps/api/src/db/queries/roster.ts` instead — same batched-query shape, different return contract.
- No CSV/Excel parsing exists for Roster today. Reuses the exact `exceljs`-based parser/results infrastructure built for Students & Parents (`bulkImportParser.ts`, `bulkImportResults.ts` patterns) rather than a second copy — see Behavior for the specific new module names.

## Decisions Made

- **One file, three sheets** (Classes, Subjects, Teacher Assignments), one upload, one commit — not three separate import flows. Matches how the Roster settings page itself is already organized (three tabs).
- **`.xlsx` only — no CSV support for this feature.** CSV is a flat, single-table format and cannot represent three sheets; the "one file, three sheets" decision above is only coherent for a real workbook format. This is a deliberate divergence from Students & Parents (which accepts both `.xlsx` and `.csv`, since that feature is genuinely one flat table).
- **Teacher Assignment rows resolve only against pre-existing data**, never against a class/subject created earlier in the same file/commit. This was a deliberate simplicity trade-off: it removes all same-file dependency-ordering and name-collision-resolution logic, at the cost of a from-scratch school setup needing two passes (Classes+Subjects first, then a second upload for Assignments once those exist). Explicitly chosen over the more powerful but more complex alternative.
- **Commit processes sheets in a fixed order — Classes, then Subjects, then Teacher Assignments** — even though Assignments don't depend on same-commit data, this keeps the commit's own results/audit trail naturally ordered and matches the sheet order in the file.
- **Two-step preview/commit flow**, identical shape to Students & Parents: nothing written until confirmed, commit re-validates from scratch server-side rather than trusting client-supplied row data.
- **Row cap: 300 rows total across all three sheets combined**, enforced at preview time. Deliberately more generous than Students & Parents' 50-row cap — a real school's whole roster setup (classes + subjects + assignments) is typically 10-60 rows, and each row here is a single fast insert (no multi-table transaction, no password hashing), so there's no realistic risk of the timing problem that forced the Students cap down. Not independently re-measured against production before shipping; if a future school's usage pattern suggests otherwise, revisit then.
- **Role gate: `principal`/`super_admin` only, matching the existing single-item Roster routes exactly.** `registrar` is deliberately excluded — this is not a new permission grant, just the existing Roster permission boundary applied to the bulk path too.
- **No credentials/results-file password section** — unlike Students & Parents, nothing here creates a user account or a password. The results file is a straightforward per-sheet summary of what was created.
- **Teacher lookup key: email.** Class lookup key: exact `name` match. Subject lookup key: `code` (uppercased to match storage). These mirror the exact fields each existing single-item route already treats as the natural unique identifier.

## Behavior

### 1. Backend — file parsing

New module `apps/api/src/services/rosterBulkImportParser.ts`, using `exceljs` (already a project dependency) to read a workbook with three named sheets: `Classes`, `Subjects`, `Teacher Assignments`. Each sheet is parsed independently into its own row-array type, using the same header-matching (case-insensitive, order-independent) and blank-row-skipping approach established in `bulkImportParser.ts` — including that fix's lesson learned: a row is only skipped if genuinely blank across every mapped column, never merely because one particular required field (e.g. Class Name) is empty; a partially-filled row becomes a validation error, not a silent drop. `row_number` for every row is the real sheet row (header included), matching the same fix applied to the Students & Parents parser.

Expected columns per sheet:

**Classes:**

| Column | Required? |
|---|---|
| Name | required |
| Level | required |
| Stream | optional |
| Form Teacher Email | optional |

**Subjects:**

| Column | Required? |
|---|---|
| Name | required |
| Code | required |

**Teacher Assignments:**

| Column | Required? |
|---|---|
| Teacher Email | required |
| Class Name | required |
| Subject Code | required |

### 2. Backend — validation

New module `apps/api/src/services/rosterBulkImportValidation.ts`, exporting one validation function per sheet plus a combined `runFullRosterValidation()`, all following the same dependency-injection shape as the Students & Parents validator (external lookups passed in as functions, so the module stays a pure, DB-free unit under test).

**Classes:** required fields present, length limits matching `classSchema` (name ≤255, level ≤100, stream ≤100), in-file duplicate `name` detection, DB duplicate check via a batched `listClasses(schoolId)` call (one query for the whole sheet, not one per row), and — if Form Teacher Email is given — resolution via the new `findTeachersByEmails(schoolId, emails)` (see Current State) confirming the email belongs to a `teacher`-role account in this school and yielding the id to store.

**Subjects:** required fields present, length limits matching `subjectSchema` (name ≤255, code ≤20), code uppercased before comparison/storage, in-file duplicate `code` detection, DB duplicate check via a batched `listActiveSubjects(schoolId)` call.

**Teacher Assignments:** required fields present; Teacher Email resolves to an existing `teacher`-role user in this school via the same `findTeachersByEmails()` batched lookup; Class Name resolves to an existing class in this school (matched against the same `listClasses` result used for the Classes sheet's own duplicate check — one query, reused); Subject Code (uppercased) resolves to an existing subject in this school (matched against the same `listActiveSubjects` result); an active term exists for the school (`getActiveTerm` — if absent, every Assignment row fails with the same message the single-create route gives, `"No active term found for this school. Activate a session and term first."`); in-file duplicate teacher+class+subject combination; DB duplicate check via `findDuplicateAssignment` for the resolved IDs + current term.

### 3. Backend — endpoints

```
POST /:schoolId/roster/bulk-import/preview
  verifyToken, requireSchoolAccess, requireRole('super_admin','principal')
  multer upload.single('file'), limits: { fileSize: 5 * 1024 * 1024 } // 5MB
  → parses all 3 sheets, enforces 300-row cap (total across sheets, rejected
    with a clear error above that before any validation runs), runs
    runFullRosterValidation() once per sheet using batched lookups
  → 200 { success: true, data: {
      classes: { rows: [...], summary: {...} },
      subjects: { rows: [...], summary: {...} },
      assignments: { rows: [...], summary: {...} },
    } }
  Writes nothing.

POST /:schoolId/roster/bulk-import/commit
  verifyToken, requireSchoolAccess, requireRole('super_admin','principal')
  body: { classes: [...], subjects: [...], assignments: [...] }  // exactly the
    "valid" rows per sheet as returned by preview
  → re-runs runFullRosterValidation() on all three sheets against current DB
    state (never trusts client-supplied row status)
  → commits in order: Classes (each insertClass() call), then Subjects (each
    insertSubject() call), then Teacher Assignments (each insertTeacherAssignment()
    call) — one row, one insert, wrapped in a per-row try/catch so one bad row
    can't block the rest of that sheet or a later sheet
  → invalidates the same roster:<schoolId>:classes / :subjects cache keys the
    single-item routes already invalidate on write (cache.del, matching
    roster.ts's existing pattern) — otherwise a bulk-created class/subject
    would be invisible in the UI until the 60s cache TTL expires
  → 200 { success: true, data: {
      classes: { created: N, failed: N, results: [...] },
      subjects: { created: N, failed: N, results: [...] },
      assignments: { created: N, failed: N, results: [...] },
      download_base64: <xlsx>,
    } }
```

The results workbook (new `apps/api/src/services/rosterBulkImportResults.ts`, mirroring `bulkImportResults.ts`'s shape) has a Summary sheet plus one sheet per resource type listing what was created — no credentials section, since nothing here has a password.

### 4. Frontend

New page `apps/web/app/(dashboard)/settings/roster/import/page.tsx`, linked from the existing Roster settings page (`apps/web/app/(dashboard)/settings/roster/page.tsx`) the same way the Students page links to its own import page. Same three-step flow (upload → preview → commit/results), adapted to show three sections in the preview step (one per sheet) instead of one flat table. A branded downloadable `.xlsx` template with all three sheets pre-built (headers + one obviously-fake example row per sheet, following the exact placeholder convention — `EXAMPLE` / `DELETE-THIS-ROW` — already established for the Students template) is available on the page.

### 5. Testing

- Unit tests for the parser (all 3 sheets, header matching, blank-row handling, row numbering) and the validator (required fields, length limits, in-file duplicates per sheet, cross-sheet-independent DB resolution for Assignments) — no DB, lookups injected as stubs, matching the Students & Parents test conventions.
- Integration tests (real test DB) for both endpoints: preview writes nothing across all three sheets; commit creates classes/subjects/assignments correctly and in the right order; a bad row in one sheet doesn't block good rows in that sheet or later sheets; the "no active term" case fails every Assignment row with a clear message and doesn't affect Classes/Subjects; the 300-row cap is enforced; role gating matches the existing single-item routes exactly (registrar rejected, unlike Students).
- Manual end-to-end pass using the real downloadable template, including the two-pass scenario explicitly chosen in Decisions Made (import Classes+Subjects first, then a second import for Assignments referencing them).
