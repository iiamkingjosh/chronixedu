# Staff/Users Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a principal/super_admin upload a single flat spreadsheet (`.xlsx` or `.csv`) of staff members (teacher/registrar/bursar/principal), preview per-row validation, and commit — creating both the Supabase Auth identity and the local `users` row for each valid row, with a shared fixed temp password and a welcome email per new account.

**Architecture:** Two new endpoints on the existing `apps/api/src/routes/users.ts` router — `POST /:schoolId/staff-bulk-import/preview` (parses + validates, writes nothing) and `POST /:schoolId/staff-bulk-import/commit` (re-validates from scratch, then creates). Mirrors the two-step preview/commit pattern from the Students & Parents and Roster bulk imports, reusing the existing `findUsersRolesByEmails` platform-wide email lookup from `db/queries/students.ts` rather than duplicating it. A new frontend page drives upload → preview → commit, adapted from the Students import page's single-flat-table layout.

**Tech Stack:** Express + TypeScript + Zod + `pg`, `exceljs` (CSV+XLSX parsing, existing dependency), `bcryptjs`, Supabase Auth admin API (`supabaseAdmin.auth.admin.createUser`), Next.js 14 App Router.

**Spec:** `docs/superpowers/specs/2026-08-20-staff-bulk-import-design.md`

## Global Constraints

- File formats: **`.xlsx` and `.csv` both accepted** — a single flat table has no multi-sheet constraint (unlike Roster).
- Roles creatable via this feature: **`teacher`, `registrar`, `bursar`, `principal`** only. Never `parent`/`student` (owned by the Students & Parents import) or `super_admin` (separate platform flow) — reject both explicitly.
- Role gate on both endpoints: `requireRole('super_admin', 'principal')` — matches the existing single-item `POST /:schoolId/users` route exactly. No registrar.
- Temp password: fixed `Password2$` for every created account — same policy as Students & Parents and Roster.
- Row cap: **50 rows**, starting value pending the real-world timing measurement in Task 6 (Supabase Auth's admin API is an external call per row, unlike the DB-only Students/Roster commits).
- Every created account gets a welcome email (email + `Password2$`), batched the same way as Students & Parents' parent-welcome emails (batches of 50, 1-second pause between batches) — per the user's explicit confirmation during design.
- Every created account gets an audit-log entry (`USER_CREATE`), matching the single-item route, plus one summary-level `STAFF_BULK_IMPORT` audit entry for the whole commit — matching the Students & Parents pattern (`STUDENTS_BULK_IMPORT` summary entry).
- Commit re-validates every row from scratch — never trusts the client-supplied row data or `status` field from preview.
- One row = one `createUser` (Supabase Auth) + one `insertUser` (local DB) pair, wrapped in its own try/catch — one bad row must not block the rest of the batch. If `createUser` succeeds but `insertUser` then fails, the resulting orphaned Supabase Auth account is an accepted, pre-existing risk (same two-call sequence with no rollback exists in today's single-item route) — not something this feature needs to solve.

---

### Task 1: File parser (`staffBulkImportParser.ts`)

**Files:**
- Create: `apps/api/src/services/staffBulkImportParser.ts`
- Test: `apps/api/src/__tests__/staffBulkImportParser.test.ts`

**Interfaces:**
- Produces: `ParsedStaffRow`, `StaffBulkImportParseError`, `parseStaffBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedStaffRow[]>` — consumed by Task 2 (validation) and Task 3 (preview endpoint).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/staffBulkImportParser.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { parseStaffBulkImportFile, StaffBulkImportParseError } from '../services/staffBulkImportParser';

async function xlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Staff');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Email', 'First Name', 'Last Name', 'Role', 'Title', 'Phone', 'Teaching Mode'];

describe('parseStaffBulkImportFile', () => {
  it('parses a well-formed teacher row from .xlsx', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['Chidi@Example.COM', 'Chidi', 'Okafor', 'Teacher', 'Mr.', '08012345678', 'Subject']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_number: 2,
      email: 'chidi@example.com',
      first_name: 'Chidi',
      last_name: 'Okafor',
      role: 'teacher',
      title: 'Mr.',
      phone: '08012345678',
      teacher_mode: 'subject',
    });
  });

  it('parses the same shape from .csv', async () => {
    const csv = 'Email,First Name,Last Name,Role,Title,Phone,Teaching Mode\nbimpe@example.com,Bimpe,Ade,Registrar,,,\n';
    const rows = await parseStaffBulkImportFile(Buffer.from(csv), 'staff.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row_number: 2, email: 'bimpe@example.com', role: 'registrar', title: null, teacher_mode: null });
  });

  it('lowercases email and role, leaves title/phone as-is', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['Bursar@Example.com', 'Femi', 'Ola', 'BURSAR', 'Dr.', '', '']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows[0].email).toBe('bursar@example.com');
    expect(rows[0].role).toBe('bursar');
    expect(rows[0].title).toBe('Dr.');
  });

  it('assigns the real sheet row number and skips fully blank rows without compacting', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['a@example.com', 'A', 'One', 'teacher', '', '', 'class'],
      ['', '', '', '', '', '', ''],
      ['b@example.com', 'B', 'Two', 'teacher', '', '', 'class'],
    ]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows.map(r => r.row_number)).toEqual([2, 4]);
  });

  it('does not drop a row that has content but is missing a required field', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['', 'A', 'One', 'teacher', '', '', 'class']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: '', first_name: 'A' });
  });

  it('throws StaffBulkImportParseError when a required column is missing', async () => {
    const buffer = await xlsxBuffer(['Email', 'First Name'], [['a@example.com', 'A']]); // missing Last Name, Role
    await expect(parseStaffBulkImportFile(buffer, 'staff.xlsx')).rejects.toThrow(StaffBulkImportParseError);
  });

  it('matches headers case-insensitively', async () => {
    const buffer = await xlsxBuffer(['email', 'FIRST NAME', 'last name', 'role'], [['a@example.com', 'A', 'One', 'teacher']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows[0]).toMatchObject({ email: 'a@example.com', first_name: 'A', last_name: 'One', role: 'teacher' });
  });

  it('leaves teacher_mode null when the column is blank, not the empty string', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['a@example.com', 'A', 'One', 'principal', '', '', '']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows[0].teacher_mode).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/staffBulkImportParser.test.ts`
Expected: FAIL with "Cannot find module '../services/staffBulkImportParser'"

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/staffBulkImportParser.ts`:

```ts
import ExcelJS from 'exceljs';
import { Readable } from 'stream';

export interface ParsedStaffRow {
  row_number: number;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  title: string | null;
  phone: string | null;
  teacher_mode: string | null;
}

export class StaffBulkImportParseError extends Error {}

const REQUIRED_HEADERS = ['email', 'first name', 'last name', 'role'];

const COLUMN_MAP: Record<string, string> = {
  'email': 'email',
  'first name': 'first_name',
  'last name': 'last_name',
  'role': 'role',
  'title': 'title',
  'phone': 'phone',
  'teaching mode': 'teacher_mode',
};

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: unknown }).text).trim() || null;
  }
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return String((value as { result: unknown }).result).trim() || null;
  }
  const str = String(value).trim();
  return str === '' ? null : str;
}

async function worksheetFromBuffer(buffer: Buffer, filename: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv') {
    return workbook.csv.read(Readable.from(buffer));
  }
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new StaffBulkImportParseError('The file has no worksheet.');
  return sheet;
}

export async function parseStaffBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedStaffRow[]> {
  const sheet = await worksheetFromBuffer(buffer, filename);

  const headerRow = sheet.getRow(1);
  const columnIndexToField = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellText(cell.value)?.toLowerCase();
    if (header && COLUMN_MAP[header]) {
      columnIndexToField.set(colNumber, COLUMN_MAP[header]);
    }
  });

  const foundFields = new Set(columnIndexToField.values());
  const missing = REQUIRED_HEADERS.filter(h => !foundFields.has(COLUMN_MAP[h]));
  if (missing.length > 0) {
    throw new StaffBulkImportParseError(`The file is missing required column(s): ${missing.map(h => COLUMN_MAP[h]).join(', ')}`);
  }

  const rows: ParsedStaffRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string | null> = {};
    columnIndexToField.forEach((field, colNumber) => {
      raw[field] = cellText(row.getCell(colNumber).value);
    });
    const hasAnyContent = Object.values(raw).some(v => v !== null);
    if (!hasAnyContent) return;

    rows.push({
      row_number: rowNumber,
      email: raw.email ? raw.email.toLowerCase() : '',
      first_name: raw.first_name ?? '',
      last_name: raw.last_name ?? '',
      role: raw.role ? raw.role.toLowerCase() : '',
      title: raw.title ?? null,
      phone: raw.phone ?? null,
      teacher_mode: raw.teacher_mode ? raw.teacher_mode.toLowerCase() : null,
    });
  });

  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/staffBulkImportParser.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/staffBulkImportParser.ts apps/api/src/__tests__/staffBulkImportParser.test.ts
git commit -m "feat: add Staff bulk-import file parser (.xlsx/.csv)"
```

---

### Task 2: Validation module (`staffBulkImportValidation.ts`)

**Files:**
- Create: `apps/api/src/services/staffBulkImportValidation.ts`
- Test: `apps/api/src/__tests__/staffBulkImportValidation.test.ts`

**Interfaces:**
- Consumes: `ParsedStaffRow` (Task 1); `findUsersRolesByEmails(emails: string[]): Promise<Map<string, string>>` — **already exists** in `apps/api/src/db/queries/students.ts` (platform-wide email→role lookup, exactly what this feature needs since `users.email` is globally unique — reused as-is, not duplicated).
- Produces: `StaffValidationResult`, `STAFF_ROLES`, `validateStaffRowShape(row: ParsedStaffRow): string[]`, `findDuplicatesWithinFile(rows: ParsedStaffRow[]): Set<number>`, `runFullStaffValidation(rows: ParsedStaffRow[], lookupEmailRoles: (emails: string[]) => Promise<Map<string, string>>): Promise<StaffValidationResult[]>` — consumed by Task 3 and Task 4.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/staffBulkImportValidation.test.ts`:

```ts
import { runFullStaffValidation, validateStaffRowShape, findDuplicatesWithinFile } from '../services/staffBulkImportValidation';
import type { ParsedStaffRow } from '../services/staffBulkImportParser';

function row(overrides: Partial<ParsedStaffRow> = {}): ParsedStaffRow {
  return {
    row_number: 2,
    email: 'chidi@example.com',
    first_name: 'Chidi',
    last_name: 'Okafor',
    role: 'teacher',
    title: null,
    phone: null,
    teacher_mode: 'subject',
    ...overrides,
  };
}

describe('validateStaffRowShape', () => {
  it('accepts a minimal valid teacher row', () => {
    expect(validateStaffRowShape(row())).toEqual([]);
  });

  it('flags a missing email, first name, last name', () => {
    const errors = validateStaffRowShape(row({ email: '', first_name: '', last_name: '' }));
    expect(errors).toContain('Email is required.');
    expect(errors).toContain('First Name is required.');
    expect(errors).toContain('Last Name is required.');
  });

  it('flags an invalid email format', () => {
    expect(validateStaffRowShape(row({ email: 'not-an-email' }))).toContain('Email "not-an-email" is not a valid email address.');
  });

  it('flags a role outside teacher/registrar/bursar/principal', () => {
    expect(validateStaffRowShape(row({ role: 'parent' }))).toContain('Role must be one of: teacher, registrar, bursar, principal.');
    expect(validateStaffRowShape(row({ role: 'student' }))).toContain('Role must be one of: teacher, registrar, bursar, principal.');
    expect(validateStaffRowShape(row({ role: 'super_admin' }))).toContain('Role must be one of: teacher, registrar, bursar, principal.');
  });

  it('requires teacher_mode when role is teacher', () => {
    expect(validateStaffRowShape(row({ role: 'teacher', teacher_mode: null }))).toContain('Teaching Mode is required for a teacher (must be "class" or "subject").');
  });

  it('rejects an invalid teacher_mode value', () => {
    expect(validateStaffRowShape(row({ role: 'teacher', teacher_mode: 'both' }))).toContain('Teaching Mode must be "class" or "subject".');
  });

  it('rejects a teacher_mode value on a non-teacher row', () => {
    expect(validateStaffRowShape(row({ role: 'registrar', teacher_mode: 'subject' }))).toContain('Teaching Mode must be blank unless Role is teacher.');
  });

  it('accepts a non-teacher row with no teacher_mode', () => {
    expect(validateStaffRowShape(row({ role: 'registrar', teacher_mode: null }))).toEqual([]);
  });

  it('flags field lengths over the createUserSchema limits', () => {
    const errors = validateStaffRowShape(row({ title: 'x'.repeat(21), phone: 'x'.repeat(51), first_name: 'x'.repeat(256) }));
    expect(errors).toContain('Title must be 20 characters or fewer.');
    expect(errors).toContain('Phone must be 50 characters or fewer.');
    expect(errors).toContain('First Name must be 255 characters or fewer.');
  });
});

describe('findDuplicatesWithinFile', () => {
  it('flags the second of two rows sharing an email, case-insensitively', () => {
    const rows = [row({ row_number: 2, email: 'a@example.com' }), row({ row_number: 3, email: 'A@Example.com' })];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set([3]));
  });

  it('does not flag two different emails', () => {
    const rows = [row({ row_number: 2, email: 'a@example.com' }), row({ row_number: 3, email: 'b@example.com' })];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set());
  });
});

describe('runFullStaffValidation', () => {
  it('marks a valid row as valid when the email has no existing account', async () => {
    const results = await runFullStaffValidation([row()], async () => new Map());
    expect(results[0].status).toBe('valid');
  });

  it('flags an email that already belongs to an existing account', async () => {
    const results = await runFullStaffValidation([row()], async () => new Map([['chidi@example.com', 'teacher']]));
    expect(results[0].status).toBe('error');
    expect(results[0].errors[0]).toContain('already registered to an existing teacher account');
  });

  it('flags in-file duplicates alongside shape errors', async () => {
    const rows = [row({ row_number: 2 }), row({ row_number: 3 })];
    const results = await runFullStaffValidation(rows, async () => new Map());
    expect(results[0].status).toBe('valid');
    expect(results[1].status).toBe('error');
    expect(results[1].errors[0]).toContain('also appears in an earlier row');
  });

  it('does not call the email lookup when there are no rows', async () => {
    const lookup = jest.fn(async () => new Map());
    await runFullStaffValidation([], lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/staffBulkImportValidation.test.ts`
Expected: FAIL with "Cannot find module '../services/staffBulkImportValidation'"

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/staffBulkImportValidation.ts`:

```ts
import type { ParsedStaffRow } from './staffBulkImportParser';

export const STAFF_ROLES = ['teacher', 'registrar', 'bursar', 'principal'] as const;
export type StaffRole = typeof STAFF_ROLES[number];

export interface StaffValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  staff: ParsedStaffRow;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateStaffRowShape(row: ParsedStaffRow): string[] {
  const errors: string[] = [];

  if (!row.email) errors.push('Email is required.');
  else if (!EMAIL_PATTERN.test(row.email)) errors.push(`Email "${row.email}" is not a valid email address.`);

  if (!row.first_name) errors.push('First Name is required.');
  else if (row.first_name.length > 255) errors.push('First Name must be 255 characters or fewer.');

  if (!row.last_name) errors.push('Last Name is required.');
  else if (row.last_name.length > 255) errors.push('Last Name must be 255 characters or fewer.');

  if (!row.role) {
    errors.push('Role is required.');
  } else if (!(STAFF_ROLES as readonly string[]).includes(row.role)) {
    errors.push(`Role must be one of: ${STAFF_ROLES.join(', ')}.`);
  }

  if (row.title && row.title.length > 20) errors.push('Title must be 20 characters or fewer.');
  if (row.phone && row.phone.length > 50) errors.push('Phone must be 50 characters or fewer.');

  if (row.role === 'teacher') {
    if (!row.teacher_mode) {
      errors.push('Teaching Mode is required for a teacher (must be "class" or "subject").');
    } else if (row.teacher_mode !== 'class' && row.teacher_mode !== 'subject') {
      errors.push('Teaching Mode must be "class" or "subject".');
    }
  } else if (row.teacher_mode) {
    errors.push('Teaching Mode must be blank unless Role is teacher.');
  }

  return errors;
}

/** Row numbers that repeat an earlier row's email, case-insensitively — email
 *  is the true uniqueness key here (unlike Students, where student email is
 *  optional and a name+email composite key was needed). */
export function findDuplicatesWithinFile(rows: ParsedStaffRow[]): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  for (const row of rows) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    if (seen.has(key)) {
      duplicates.add(row.row_number);
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

/**
 * Combines shape validation, in-file duplicate detection, and a DB-backed
 * email-conflict check into the final per-row verdict. lookupEmailRoles is
 * injected so this stays unit-testable without a real database — the route
 * layer wires it to the existing findUsersRolesByEmails query.
 */
export async function runFullStaffValidation(
  rows: ParsedStaffRow[],
  lookupEmailRoles: (emails: string[]) => Promise<Map<string, string>>
): Promise<StaffValidationResult[]> {
  const duplicateRowNumbers = findDuplicatesWithinFile(rows);

  const allEmails = new Set<string>();
  for (const row of rows) {
    if (row.email) allEmails.add(row.email.toLowerCase());
  }
  const existingRoles = allEmails.size > 0 ? await lookupEmailRoles([...allEmails]) : new Map<string, string>();

  return rows.map(row => {
    const errors = validateStaffRowShape(row);

    if (duplicateRowNumbers.has(row.row_number)) {
      errors.push('This email also appears in an earlier row of this file.');
    }

    if (row.email) {
      const existingRole = existingRoles.get(row.email.toLowerCase());
      if (existingRole) {
        errors.push(`Email "${row.email}" is already registered to an existing ${existingRole} account.`);
      }
    }

    return {
      row_number: row.row_number,
      status: errors.length === 0 ? 'valid' as const : 'error' as const,
      errors,
      staff: row,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/staffBulkImportValidation.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/staffBulkImportValidation.ts apps/api/src/__tests__/staffBulkImportValidation.test.ts
git commit -m "feat: add Staff bulk-import validation"
```

---

### Task 3: Preview endpoint

**Files:**
- Modify: `apps/api/src/routes/users.ts`
- Test: `apps/api/tests/staffBulkImport.test.ts` (new file — DB-integration style, matching `apps/api/tests/studentsBulkImport.test.ts` and `apps/api/tests/rosterBulkImport.test.ts` conventions)

**Interfaces:**
- Consumes: `parseStaffBulkImportFile`, `StaffBulkImportParseError` (Task 1); `runFullStaffValidation` (Task 2); `findUsersRolesByEmails` (existing, from `../db/queries/students`).
- Produces: `POST /:schoolId/staff-bulk-import/preview` — consumed by the frontend in Task 5.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/staffBulkImport.test.ts`:

```ts
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

jest.setTimeout(30000);

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';

import pool from '../src/db/client';
import usersRouter from '../src/routes/users';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/schools', verifyToken);
app.use('/api/schools', usersRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function xlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Staff');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Email', 'First Name', 'Last Name', 'Role', 'Title', 'Phone', 'Teaching Mode'];

describe('POST /:schoolId/staff-bulk-import/preview', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;
  let existingEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Staff Bulk Preview Test School', `test-staff-preview-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject') RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const existingResult = await pool.query<{ email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING email`,
      [schoolId, `existing-${randomUUID()}@test.com`]
    );
    existingEmail = existingResult.rows[0].email;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    // pool is NOT closed here — Task 4 adds a sibling describe block below
    // that still needs it. A single top-level afterAll closes it once.
  }, 30000);

  it('rejects a registrar with 403 (matches the single-item staff-creation route\'s gate)', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['a@example.com', 'A', 'One', 'teacher', '', '', 'class']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid teacher row and flags a row whose email already exists', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['new-teacher@example.com', 'New', 'Teacher', 'teacher', '', '', 'class'],
      [existingEmail, 'Existing', 'Person', 'registrar', '', '', ''],
    ]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 2, valid: 1, invalid: 1 });
    const failedRow = res.body.data.rows.find((r: { status: string }) => r.status === 'error');
    expect(failedRow.errors[0]).toContain('already registered to an existing teacher account');
  });

  it('rejects a row with role=parent outright', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['x@example.com', 'X', 'Y', 'parent', '', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('Role must be one of');
  });

  it('accepts a .csv upload', async () => {
    const csv = 'Email,First Name,Last Name,Role,Title,Phone,Teaching Mode\ncsv-user@example.com,C,User,bursar,,,\n';
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', Buffer.from(csv), 'staff.csv');
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
  });

  it('rejects a file missing a required column', async () => {
    const buffer = await xlsxBuffer(['Email', 'First Name'], [['a@example.com', 'A']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a workbook with more than 50 rows', async () => {
    const manyRows = Array.from({ length: 51 }, (_, i) => [`user${i}@example.com`, 'A', 'One', 'teacher', '', '', 'class']);
    const buffer = await xlsxBuffer(HEADERS, manyRows);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/staffBulkImport.test.ts`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 3: Add imports to `apps/api/src/routes/users.ts`**

Extend the existing imports at the top of the file:

```ts
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { findUsersRolesByEmails } from '../db/queries/students';
import { parseStaffBulkImportFile, StaffBulkImportParseError } from '../services/staffBulkImportParser';
import { runFullStaffValidation } from '../services/staffBulkImportValidation';
```

(`fileTypeFromBuffer` is already imported in this file for the signature-upload route — do not duplicate the import, just confirm it's there. `STAFF_ROLES` is not needed until Task 4's commit handler — add it to this import list there, not here.)

- [ ] **Step 4: Add the preview route**

Insert immediately before `export default router;` at the end of `apps/api/src/routes/users.ts`:

```ts
// ── POST /:schoolId/staff-bulk-import/preview ───────────────────────────────
// Parses and validates a flat staff spreadsheet without writing anything —
// the principal confirms via /staff-bulk-import/commit afterward. See
// docs/superpowers/specs/2026-08-20-staff-bulk-import-design.md for the
// full design rationale.

const MAX_STAFF_BULK_IMPORT_ROWS = 50;
const staffBulkImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post(
  '/:schoolId/staff-bulk-import/preview',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  staffBulkImportUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

      // Magic-byte check only applies to .xlsx — plain-text CSV has no reliable
      // magic-byte signature, matching the Students & Parents bulk import.
      const isXlsxByName = file.originalname.toLowerCase().endsWith('.xlsx');
      if (isXlsxByName) {
        const detected = await fileTypeFromBuffer(file.buffer);
        const allowedXlsxMimes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'];
        if (!detected || !allowedXlsxMimes.includes(detected.mime)) {
          return res.status(400).json({
            success: false,
            error: { code: 'PARSE_ERROR', message: 'This file could not be read as an Excel spreadsheet.' },
          });
        }
      }

      let parsedRows;
      try {
        parsedRows = await parseStaffBulkImportFile(file.buffer, file.originalname);
      } catch (err) {
        if (err instanceof StaffBulkImportParseError) {
          return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: err.message } });
        }
        return res.status(400).json({
          success: false,
          error: { code: 'PARSE_ERROR', message: 'This file could not be read. Please check it is a valid .xlsx or .csv file.' },
        });
      }

      if (parsedRows.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'No staff rows were found in this file.' } });
      }
      if (parsedRows.length > MAX_STAFF_BULK_IMPORT_ROWS) {
        return res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_ROWS', message: `This file has ${parsedRows.length} rows — the maximum per import is ${MAX_STAFF_BULK_IMPORT_ROWS}. Split it into multiple files.` },
        });
      }

      const results = await runFullStaffValidation(parsedRows, findUsersRolesByEmails);
      const summary = {
        total: results.length,
        valid: results.filter(r => r.status === 'valid').length,
        invalid: results.filter(r => r.status === 'error').length,
      };

      return res.json({ success: true, data: { rows: results, summary } });
    } catch (err) {
      return next(err);
    }
  }
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/staffBulkImport.test.ts --runInBand`
Expected: PASS (6 tests)

- [ ] **Step 6: Run typecheck and lint**

Run: `cd apps/api && npx tsc --noEmit && npx eslint src/routes/users.ts --ext .ts`
Expected: no errors (watch for `no-inner-declarations` if any inline `function` is declared inside the handler — use `const fn = (...) => ...` instead, as the Roster preview endpoint had to)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/tests/staffBulkImport.test.ts
git commit -m "feat: add Staff bulk-import preview endpoint"
```

---

### Task 4: Results generator + commit endpoint

**Files:**
- Create: `apps/api/src/services/staffBulkImportResults.ts`
- Modify: `apps/api/src/routes/users.ts`
- Modify: `apps/api/tests/staffBulkImport.test.ts` (add a new `describe` block)

**Interfaces:**
- Produces (from `staffBulkImportResults.ts`): `generateStaffBulkImportResultsFile(created: CreatedStaffRecord[]): Promise<Buffer>`, `CreatedStaffRecord`.
- Produces (from the route): `POST /:schoolId/staff-bulk-import/commit` — consumed by the frontend in Task 5.
- Consumes: `supabaseAdmin` (existing import in `users.ts`), `insertUser`, `NewUserInput` (existing, from `../db/queries/users`), `logAudit` (existing, from `../db/queries/auditLog`), `sendEmail` (existing, from `../services/emailService`), `runFullStaffValidation` (Task 2).

- [ ] **Step 1: Write the failing unit test for the results file generator**

Create `apps/api/src/__tests__/staffBulkImportResults.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { generateStaffBulkImportResultsFile } from '../services/staffBulkImportResults';

describe('generateStaffBulkImportResultsFile', () => {
  it('produces a workbook with a Summary sheet and a Staff Created sheet', async () => {
    const buffer = await generateStaffBulkImportResultsFile([
      { row_number: 2, first_name: 'Chidi', last_name: 'Okafor', email: 'chidi@example.com', role: 'teacher' },
    ]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Staff Created']);
    expect(workbook.getWorksheet('Staff Created')!.getRow(2).getCell(5).value).toBe('teacher');
  });

  it('handles an empty input without error', async () => {
    const buffer = await generateStaffBulkImportResultsFile([]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/__tests__/staffBulkImportResults.test.ts`
Expected: FAIL with "Cannot find module '../services/staffBulkImportResults'"

- [ ] **Step 3: Write the results file generator**

Create `apps/api/src/services/staffBulkImportResults.ts`:

```ts
import ExcelJS from 'exceljs';

export interface CreatedStaffRecord {
  row_number: number;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
}

export async function generateStaffBulkImportResultsFile(created: CreatedStaffRecord[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Staff Bulk Import Results']);
  summary.addRow([`${created.length} staff account(s) created.`]);
  summary.addRow(['All accounts use the temporary password Password2$ — users are required to change it on first login.']);

  const staffSheet = workbook.addWorksheet('Staff Created');
  staffSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'First Name', key: 'first_name', width: 20 },
    { header: 'Last Name', key: 'last_name', width: 20 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Role', key: 'role', width: 14 },
  ];
  created.forEach(s => staffSheet.addRow(s));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/__tests__/staffBulkImportResults.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing integration test for the commit endpoint**

Add to `apps/api/tests/staffBulkImport.test.ts`, in a new `describe` block below the existing one (reusing the `app`, `makeToken`, `xlsxBuffer`, `HEADERS` helpers already defined in that file — do not redeclare). Also replace the file's final closing with a top-level `afterAll` that closes the pool once:

```ts
describe('POST /:schoolId/staff-bulk-import/commit', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Staff Bulk Commit Test School', `test-staff-commit-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject') RETURNING id, email`,
      [schoolId, `principal-commit-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-commit-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    return res.body.data;
  }

  it('rejects a registrar with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows: [] });
    expect(res.status).toBe(403);
  });

  it('creates a valid teacher row end-to-end (Supabase Auth + local DB row)', async () => {
    const email = `e2e-teacher-${randomUUID()}@example.com`;
    const buffer = await xlsxBuffer(HEADERS, [[email, 'E2E', 'Teacher', 'teacher', 'Mr.', '', 'class']]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(0);
    expect(typeof commit.body.data.download_base64).toBe('string');

    const dbRow = await pool.query(`SELECT role, teacher_mode FROM users WHERE school_id = $1 AND email = $2`, [schoolId, email]);
    expect(dbRow.rows).toHaveLength(1);
    expect(dbRow.rows[0]).toMatchObject({ role: 'teacher', teacher_mode: 'class' });
  }, 30000);

  it('does not stop the batch when one row fails validation at commit time', async () => {
    const goodEmail = `e2e-good-${randomUUID()}@example.com`;
    const buffer = await xlsxBuffer(HEADERS, [
      [goodEmail, 'Good', 'One', 'registrar', '', '', ''],
      ['not-an-email', 'Bad', 'Two', 'bursar', '', '', ''],
    ]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 2, valid: 1, invalid: 1 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(1);

    const dbRow = await pool.query(`SELECT id FROM users WHERE school_id = $1 AND email = $2`, [schoolId, goodEmail]);
    expect(dbRow.rows).toHaveLength(1);
  }, 30000);
});

// Closes the shared pg pool once, after every describe block in this file has
// finished — closing it inside an individual describe's afterAll would break
// any sibling describe block that still needs to query the database.
afterAll(async () => {
  await pool.end();
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/staffBulkImport.test.ts --runInBand -t "commit"`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 7: Add imports and the commit route to `apps/api/src/routes/users.ts`**

Extend the imports at the top of the file:

```ts
import { generateStaffBulkImportResultsFile, type CreatedStaffRecord } from '../services/staffBulkImportResults';
import { STAFF_ROLES } from '../services/staffBulkImportValidation';
import pool from '../db/client';
```

(`runFullStaffValidation` and `findUsersRolesByEmails` are already imported from Task 3 — do not duplicate those imports, just add the two above alongside them.)

Add this small helper near the top of the file, alongside `generateTempPassword` (needed for the welcome email — mirrors the identical helper already used in `routes/students.ts`):

```ts
async function getSchoolName(schoolId: string): Promise<string> {
  const r = await pool.query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolId]);
  return r.rows[0]?.name ?? 'your school';
}

function staffWelcomeEmailBody(role: string, name: string, email: string, tempPassword: string, schoolName: string, appUrl: string): string {
  return [
    `Hello ${name},`,
    '',
    `You have been added as a ${role} on Chronix Edu for ${schoolName}.`,
    '',
    'Your login credentials:',
    `  Email:    ${email}`,
    `  Password: ${tempPassword}`,
    '',
    `Log in here: ${appUrl}/login`,
    '',
    'IMPORTANT: Please change your password immediately after your first login.',
    '',
    'If you did not expect this email, please contact your school administrator.',
    '',
    '— Chronix Edu',
  ].join('\n');
}
```

Insert immediately after the preview route added in Task 3, before `export default router;`:

```ts
// ── POST /:schoolId/staff-bulk-import/commit ────────────────────────────────
// Re-validates every row from scratch — never trusts the client-supplied
// "valid"/"error" status from preview. Each row is one Supabase Auth
// createUser() call followed by one local insertUser() call, each wrapped
// in its own try/catch so one bad row can't stop the rest of the batch. If
// createUser() succeeds but insertUser() then fails, the resulting orphaned
// Supabase Auth account is an accepted, pre-existing risk — the single-item
// POST /:schoolId/users route has the identical two-call sequence with no
// rollback today.

const STAFF_BULK_IMPORT_PASSWORD = 'Password2$';
const STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE = 50;

const staffBulkImportCommitSchema = z.object({
  rows: z.array(z.object({
    row_number: z.number(),
    status: z.enum(['valid', 'error']),
    errors: z.array(z.string()),
    staff: z.object({
      row_number: z.number(),
      email: z.string(),
      first_name: z.string(),
      last_name: z.string(),
      role: z.string(),
      title: z.string().nullable(),
      phone: z.string().nullable(),
      teacher_mode: z.string().nullable(),
    }),
  })).min(1).max(MAX_STAFF_BULK_IMPORT_ROWS),
});

router.post(
  '/:schoolId/staff-bulk-import/commit',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = staffBulkImportCommitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const submittedRows = parsed.data.rows.map(r => r.staff);
      const revalidated = await runFullStaffValidation(submittedRows, findUsersRolesByEmails);

      const results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdStaff: CreatedStaffRecord[] = [];

      for (const row of revalidated) {
        if (row.status === 'error') {
          results.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') });
          continue;
        }

        const staff = row.staff;
        const role = staff.role as typeof STAFF_ROLES[number];
        const teacherMode = role === 'teacher' ? (staff.teacher_mode as 'class' | 'subject') : 'subject';

        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email: staff.email,
          password: STAFF_BULK_IMPORT_PASSWORD,
          email_confirm: true,
          user_metadata: { first_name: staff.first_name, last_name: staff.last_name, role, school_id: req.params.schoolId, title: staff.title, teacher_mode: teacherMode },
        });
        if (authError || !authData?.user) {
          results.push({ row_number: staff.row_number, status: 'failed', reason: authError?.message ?? 'Failed to create authentication account.' });
          continue;
        }

        try {
          const passwordHash = bcrypt.hashSync(STAFF_BULK_IMPORT_PASSWORD, 12);
          const user = await insertUser(authData.user.id, req.params.schoolId, {
            email: staff.email,
            passwordHash,
            role,
            first_name: staff.first_name,
            last_name: staff.last_name,
            title: staff.title,
            teacher_mode: teacherMode,
            phone: staff.phone,
          });

          await logAudit({
            supportSession: req.supportSession,
            schoolId: req.params.schoolId,
            userId: req.user!.user_id,
            actionType: 'USER_CREATE',
            entity: 'users',
            entityId: user.id,
            newValue: { email: user.email, role: user.role, teacher_mode: user.teacher_mode },
          });

          results.push({ row_number: staff.row_number, status: 'created' });
          createdStaff.push({ row_number: staff.row_number, first_name: staff.first_name, last_name: staff.last_name, email: staff.email, role });
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'An account with this email already exists.'
            : 'Failed to create this record.';
          results.push({ row_number: staff.row_number, status: 'failed', reason });
        }
      }

      if (createdStaff.length > 0) {
        const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
        getSchoolName(req.params.schoolId).then(async schoolName => {
          for (let i = 0; i < createdStaff.length; i += STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE) {
            const batch = createdStaff.slice(i, i + STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE);
            await Promise.all(
              batch.map(s => sendEmail(
                s.email,
                'Welcome to Chronix Edu — Your Staff Account is Ready',
                staffWelcomeEmailBody(s.role, `${s.first_name} ${s.last_name}`, s.email, STAFF_BULK_IMPORT_PASSWORD, schoolName, appUrl)
              ).catch(() => {}))
            );
            if (i + STAFF_BULK_IMPORT_EMAIL_BATCH_SIZE < createdStaff.length) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }).catch(() => {});
      }

      const resultsFile = await generateStaffBulkImportResultsFile(createdStaff);

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'STAFF_BULK_IMPORT',
        entity: 'users',
        entityId: req.params.schoolId,
        newValue: { created: createdStaff.length, failed: results.filter(r => r.status === 'failed').length },
      });

      return res.json({
        success: true,
        data: {
          created: createdStaff.length,
          failed: results.filter(r => r.status === 'failed').length,
          results,
          download_base64: resultsFile.toString('base64'),
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/staffBulkImport.test.ts --runInBand`
Expected: PASS (all tests in the file — preview + commit describe blocks)

- [ ] **Step 9: Run typecheck and lint**

Run: `cd apps/api && npx tsc --noEmit && npx eslint src/routes/users.ts --ext .ts`
Expected: no errors

- [ ] **Step 10: Before committing, check for and clean up orphaned test data**

This project's shared test database has previously accumulated orphaned rows from interrupted test runs. Run this check and clean up if needed before your final test run:

```bash
cd apps/api && node -e "
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const schools = await pool.query(\"SELECT id FROM schools WHERE name LIKE 'Staff Bulk%'\");
  const ids = schools.rows.map(r => r.id);
  console.log('found:', ids.length);
  if (ids.length > 0) {
    await pool.query('DELETE FROM users WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM schools WHERE id = ANY(\$1::uuid[])', [ids]);
  }
  console.log('cleanup done');
  await pool.end();
})().catch(e => { console.error(e); pool.end(); });
"
```

Note: this cleans up **local** `users` rows only. Any Supabase Auth identities created by earlier interrupted test runs (e.g. `e2e-teacher-*@example.com`) are orphaned in Supabase Auth itself and are not cleaned up by this script — this is the accepted risk documented in the Global Constraints, now also showing up as test-environment noise. If test runs accumulate many stray Supabase Auth accounts, clean them up manually via the Supabase dashboard; it does not affect test correctness since each test uses a fresh `randomUUID()` email.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/staffBulkImportResults.ts apps/api/src/__tests__/staffBulkImportResults.test.ts apps/api/src/routes/users.ts apps/api/tests/staffBulkImport.test.ts
git commit -m "feat: add Staff bulk-import commit endpoint, results file, and welcome emails"
```

---

### Task 5: Frontend — template asset + the import page

**Files:**
- Create: `apps/web/public/templates/staff-bulk-import-template.xlsx` (generated once via a temporary script, then committed as a static asset)
- Create: `apps/web/app/(dashboard)/settings/users/import/page.tsx`

**Interfaces:**
- Consumes: `POST /:schoolId/staff-bulk-import/preview` and `POST /:schoolId/staff-bulk-import/commit` (Tasks 3 and 4) via `apiFetch`/`apiUpload` (`apps/web/lib/api.ts`, existing).

- [ ] **Step 1: Generate the template file**

Create a temporary script at the repo root, `_gen-staff-template.js` (deleted in Step 3 — not part of the final commit):

```js
const ExcelJS = require('exceljs');

async function main() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Staff');
  sheet.columns = [
    { header: 'Email', key: 'email', width: 30 },
    { header: 'First Name', key: 'first_name', width: 18 },
    { header: 'Last Name', key: 'last_name', width: 18 },
    { header: 'Role', key: 'role', width: 14 },
    { header: 'Title', key: 'title', width: 10 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Teaching Mode', key: 'teacher_mode', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
  sheet.addRow({
    email: 'delete-this-example-row@example.com',
    first_name: 'EXAMPLE',
    last_name: 'DELETE-THIS-ROW',
    role: 'teacher',
    title: 'Mr.',
    phone: '',
    teacher_mode: 'subject',
  });

  await wb.xlsx.writeFile(process.argv[2]);
  console.log('Template written to', process.argv[2]);
}

main();
```

Run (from repo root):

```bash
mkdir -p apps/web/public/templates
node _gen-staff-template.js apps/web/public/templates/staff-bulk-import-template.xlsx
```

The example row uses the same obviously-fake-placeholder convention established for the Students & Parents and Roster templates (`EXAMPLE`/`DELETE-THIS-ROW`/`delete-this-example-row@example.com`) — never realistic-looking data.

- [ ] **Step 2: Verify the template manually**

Open `apps/web/public/templates/staff-bulk-import-template.xlsx` and confirm: one sheet named `Staff`; 7 correctly-labeled columns; one obviously-placeholder example row with `role = teacher` and `teacher_mode = subject` filled in (demonstrating the teacher-only field).

- [ ] **Step 3: Delete the temporary script**

```bash
rm _gen-staff-template.js
```

- [ ] **Step 4: Write the import page**

Create `apps/web/app/(dashboard)/settings/users/import/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedStaff {
  row_number: number;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  title: string | null;
  phone: string | null;
  teacher_mode: string | null;
}

interface StaffRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  staff: ParsedStaff;
}

interface PreviewResponse {
  rows: StaffRow[];
  summary: { total: number; valid: number; invalid: number };
}

interface CommitResponse {
  created: number;
  failed: number;
  results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }>;
  download_base64: string;
}

type Step = 'upload' | 'preview' | 'done';

function downloadBase64File(base64: string, filename: string) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StaffBulkImportPage() {
  const { schoolId } = useAuth();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
  const [commitError, setCommitError] = useState('');

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !file) return;
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiUpload<{ success: boolean; data: PreviewResponse }>(
        `/api/schools/${schoolId}/staff-bulk-import/preview`,
        formData
      );
      setPreview(res.data);
      setStep('preview');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to process this file');
    } finally {
      setUploading(false);
    }
  }

  async function handleCommit() {
    if (!schoolId || !preview) return;
    setCommitting(true);
    setCommitError('');
    try {
      const res = await apiFetch<{ success: boolean; data: CommitResponse }>(
        `/api/schools/${schoolId}/staff-bulk-import/commit`,
        { method: 'POST', body: JSON.stringify({ rows: preview.rows.filter(r => r.status === 'valid') }) }
      );
      setCommitResult(res.data);
      setStep('done');
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <Link href="/settings/users" className="text-sm text-[#2472B4] hover:underline">← Back to User Management</Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">Bulk Import Staff</h1>
        <p className="text-sm text-gray-500 mt-1">Upload a spreadsheet of teachers, registrars, bursars, or principals — up to 50 rows per import.</p>
      </div>

      {step === 'upload' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <a
            href="/templates/staff-bulk-import-template.xlsx"
            download
            className="inline-block text-sm font-medium text-[#2472B4] hover:underline"
          >
            Download the import template (.xlsx)
          </a>
          <p className="text-xs text-gray-500">
            Every account created here gets the temporary password <span className="font-mono">Password2$</span> and a welcome email with their login details — they must change it on first login.
          </p>
          <form onSubmit={handleUpload} className="space-y-4">
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-gray-700"
            />
            {uploadError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{uploadError}</div>
            )}
            <button
              type="submit"
              disabled={!file || uploading}
              className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50"
            >
              {uploading ? 'Processing…' : 'Upload & Preview'}
            </button>
          </form>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Staff</h3>
              <span className="text-xs text-gray-500">{preview.summary.valid} of {preview.summary.total} valid</span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {preview.rows.map(r => (
                  <tr key={r.row_number}>
                    <td className="px-4 py-2 text-gray-500 w-16">{r.row_number}</td>
                    <td className="px-4 py-2">{r.staff.first_name} {r.staff.last_name} — {r.staff.email} ({r.staff.role})</td>
                    <td className="px-4 py-2 w-56">
                      {r.status === 'valid' ? (
                        <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1">Will create</span>
                      ) : (
                        <span className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1" title={r.errors.join(' ')}>
                          Error: {r.errors[0]}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {commitError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{commitError}</div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleCommit}
              disabled={preview.summary.valid === 0 || committing}
              className="px-5 py-2 bg-[#FF761B] text-white text-sm font-medium rounded-lg hover:bg-[#e56812] disabled:opacity-50"
            >
              {committing ? 'Importing…' : `Import ${preview.summary.valid} valid row${preview.summary.valid === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              onClick={() => { setStep('upload'); setFile(null); setPreview(null); }}
              className="px-5 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <p className="text-lg font-semibold text-gray-900">{commitResult.created} staff account(s) created</p>
          {commitResult.failed > 0 && (
            <p className="text-sm text-red-600">{commitResult.failed} row(s) failed — see the downloaded results file for details.</p>
          )}
          <button
            type="button"
            onClick={() => downloadBase64File(commitResult.download_base64, 'chronix-edu-staff-bulk-import-results.xlsx')}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
          >
            Download results (.xlsx)
          </button>
          <div>
            <Link href="/settings/users" className="text-sm text-[#2472B4] hover:underline">← Back to User Management</Link>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/public/templates/staff-bulk-import-template.xlsx "apps/web/app/(dashboard)/settings/users/import/page.tsx"
git commit -m "feat: add Staff bulk-import page and downloadable template"
```

---

### Task 6: Entry point on the Users page, row-cap timing measurement, and full manual verification

**Files:**
- Modify: `apps/web/app/(dashboard)/settings/users/page.tsx`

**Interfaces:**
- Consumes: the page created in Task 5 (`/settings/users/import`).

- [ ] **Step 1: Add the `Link` import and the "Bulk Import" link**

In `apps/web/app/(dashboard)/settings/users/page.tsx`, add to the top of the existing import block:

```tsx
import Link from 'next/link';
```

Find the header block (around line 566-577):

```tsx
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">User Management</h1>
        <button
          onClick={() => setCreateOpen(true)}
          className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors flex items-center gap-1.5 self-start sm:self-auto"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create User
        </button>
      </div>
```

Replace it with (adding the Bulk Import link alongside the existing Create User button):

```tsx
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">User Management</h1>
        <div className="flex gap-2 self-start sm:self-auto">
          <Link
            href="/settings/users/import"
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 flex items-center"
          >
            Bulk Import
          </Link>
          <button
            onClick={() => setCreateOpen(true)}
            className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Create User
          </button>
        </div>
      </div>
```

- [ ] **Step 2: Run typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Full backend test suite**

Run: `cd apps/api && npx jest --runInBand`
Expected: all suites pass (existing suites unaffected + all new Staff bulk-import tests from Tasks 1-4)

- [ ] **Step 4: Row-cap timing measurement (required — do not skip)**

The spec's row cap of 50 is a starting value pending a real measurement of Supabase Auth's `createUser` API latency at volume, which is unknown at plan-writing time (unlike Students & Parents, this call leaves the local Postgres round-trip entirely). Measure it directly:

1. Write a standalone throwaway script (e.g. `apps/api/_measure_staff_bulk_timing.ts`, deleted after running) that creates a test school, builds a 50-row in-memory `.xlsx` buffer of valid teacher rows with unique emails, calls the commit endpoint's logic directly (or via an HTTP request to a locally-running server) with `console.time`/`console.timeEnd` around the full batch, and reports total elapsed time and average per-row time.
2. Run it and record the result.
3. **If 50 rows completes in under ~3 minutes** (leaving comfortable margin under typical HTTP gateway timeouts, matching the reasoning that kept Students & Parents' final cap at 50 rows / ~2.5 minutes): keep `MAX_STAFF_BULK_IMPORT_ROWS = 50` as-is in `apps/api/src/routes/users.ts`. No code change needed.
4. **If it takes meaningfully longer**: lower `MAX_STAFF_BULK_IMPORT_ROWS` in `apps/api/src/routes/users.ts` (both the preview and commit route's constant, and the `staffBulkImportCommitSchema`'s `.max(...)`) to a value that keeps the full batch under ~3 minutes, based on the measured per-row time. Update the frontend copy in `apps/web/app/(dashboard)/settings/users/import/page.tsx` ("up to 50 rows per import") to match. Re-run the full backend test suite (Step 3) after any cap change, since the `rejects a workbook with more than 50 rows` test in Task 3 hardcodes 50 rows and would need updating to `MAX_STAFF_BULK_IMPORT_ROWS + 1` rows.
5. Delete the throwaway measurement script — never commit it.
6. Report the measured timing and final cap value.

- [ ] **Step 5: Manual end-to-end verification**

Write a standalone verification script (same pattern used for Students & Parents and Roster — a throwaway `ts-node` script at `apps/api/_e2e_verify_staff.ts`, deleted after running) that:
1. Creates a test school and a principal account.
2. Loads the real downloadable template file (`apps/web/public/templates/staff-bulk-import-template.xlsx`) exactly as a principal would.
3. Runs it through preview — confirms the example row previews as `valid`.
4. Commits it — confirms a Supabase Auth identity and a local `users` row both exist for the created account, with `role = 'teacher'` and `teacher_mode = 'subject'` (matching the template's example row).
5. Confirms the results file from the commit decodes as a valid `.xlsx` (starts with the `PK` zip signature).
6. Confirms a welcome email attempt was made (mock or intercept `sendEmail`, or check application logs — do not require a real inbox).
7. Cleans up all test data created (local `users` row, school) in FK-safe order. Note the created Supabase Auth identity itself is not cleaned up by this script (same accepted-risk note as Task 4's orphaned-test-data cleanup) — delete it manually via the Supabase dashboard if test-environment clutter becomes a problem.

Run it, confirm every step passes, then delete the script (never committed).

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(dashboard)/settings/users/page.tsx"
git commit -m "feat: add Bulk Import entry point to the Users page"
```

---

## Self-Review Notes

- **Spec coverage:** file formats (Task 1), role scope + validation rules including teacher_mode mutual-exclusivity (Task 2), the preview endpoint with the 50-row cap and magic-byte check (Task 3), the commit endpoint's Supabase-Auth-then-DB per-row sequence + welcome emails + audit logging + results file (Task 4), the frontend page + branded template (Task 5), and the entry point + required row-cap timing measurement + full end-to-end verification (Task 6) — every section of the spec maps to a task.
- **Reuse over duplication:** `findUsersRolesByEmails` (platform-wide email→role lookup) is imported from the existing `db/queries/students.ts` rather than reimplemented — the exact same semantics are needed here, and this codebase already establishes cross-domain query imports as a normal pattern (`roster.ts` imports `findUserById` from `db/queries/users`, `behaviour.ts`/`attendance.ts`/`fees.ts` import from `db/queries/students`, etc.).
- **Type consistency checked:** `ParsedStaffRow` (Task 1) flows unchanged into `StaffValidationResult.staff` (Task 2), which flows unchanged into the preview response shape and the commit request Zod schema (Tasks 3-4) and the frontend's `ParsedStaff`/`StaffRow` interfaces (Task 5) — field names match end to end.
- **No placeholders:** every step has real, complete code.
- **Scope discipline**: bulk-editing or deactivating existing staff, and cleaning up orphaned Supabase Auth identities from failed inserts, are both explicitly out of scope per the spec — not addressed here, consistent with how the Students & Parents plan left the pre-existing `admission_no` bug untouched.
