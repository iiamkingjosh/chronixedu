# Student & Parent Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registrar/principal/super_admin upload a spreadsheet of up to 200 students (each with up to two parents/guardians), preview exactly what will be created (including per-row errors), and commit the import — creating accounts via the exact same logic single-student registration already uses.

**Architecture:** Two new endpoints on the existing `apps/api/src/routes/students.ts` router — `POST /:schoolId/students/bulk-import/preview` (parses + validates, writes nothing) and `POST /:schoolId/students/bulk-import/commit` (re-validates from scratch, then loops `registerStudent()` once per row, one DB transaction per row). A new frontend page drives the upload → preview → commit flow. Full design rationale lives in `docs/superpowers/specs/2026-08-19-student-bulk-import-design.md` — read it before starting if anything below is unclear on *why*.

**Tech Stack:** Express + TypeScript + Zod + `pg` (existing), `exceljs` (new dependency, reads/writes both `.xlsx` and `.csv`), Next.js 14 App Router + React Hook Form (existing frontend conventions).

## Global Constraints

- Row cap: **200 rows per file**, enforced at parse time.
- Every bulk-imported account (student and every newly-created parent) gets the fixed password `Password2$` — not a random per-account password. `hashSync('Password2$', 12)` for every account, no exceptions.
- Class enrollment is NOT part of this import — imported students always have `class_id: undefined`.
- No background job queue — commit runs synchronously in the HTTP request.
- Same role gate as single registration everywhere: `requireRole('super_admin', 'principal', 'registrar')`.
- Commit must re-validate every row from scratch against current DB state — never trust the row data the client sends back from preview.
- One DB transaction per row at commit time (via `registerStudent()`, which is already transactional per-call) — never wrap the whole batch in one transaction.

---

### Task 1: File parser (`bulkImportParser.ts`)

**Files:**
- Modify: `apps/api/package.json` (add `exceljs` dependency)
- Create: `apps/api/src/services/bulkImportParser.ts`
- Test: `apps/api/src/__tests__/bulkImportParser.test.ts`

**Interfaces:**
- Produces: `ParsedStudentRow`, `ParsedParentRow`, `BulkImportParseError`, `parseBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedStudentRow[]>` — consumed by Task 2 (validation) and Task 4 (preview endpoint).

- [ ] **Step 1: Install exceljs**

Run: `cd apps/api && npm install exceljs`

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/__tests__/bulkImportParser.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { parseBulkImportFile, BulkImportParseError } from '../services/bulkImportParser';

async function makeXlsxBuffer(headers: string[], rows: (string | number | boolean)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function makeCsvBuffer(headers: string[], rows: string[][]): Buffer {
  const lines = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(','));
  return Buffer.from(lines.join('\n'), 'utf-8');
}

describe('parseBulkImportFile — .xlsx', () => {
  it('parses a well-formed row with a student and one parent', async () => {
    const buffer = await makeXlsxBuffer(
      ['First Name', 'Last Name', 'Email', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Relationship'],
      [['Tunde', 'Okonkwo', 'tunde@example.com', 'Bisi', 'Okonkwo', 'bisi@example.com', 'Mother']]
    );

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_number: 1,
      first_name: 'Tunde',
      last_name: 'Okonkwo',
      email: 'tunde@example.com',
    });
    expect(rows[0].parent1).toMatchObject({
      first_name: 'Bisi',
      last_name: 'Okonkwo',
      email: 'bisi@example.com',
      relationship_type: 'Mother',
      is_primary_contact: false,
    });
    expect(rows[0].parent2).toBeNull();
  });

  it('leaves optional student fields null when the columns are absent', async () => {
    const buffer = await makeXlsxBuffer(['First Name', 'Last Name'], [['Ada', 'Bello']]);

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows[0]).toMatchObject({ first_name: 'Ada', last_name: 'Bello', email: null, dob: null, parent1: null, parent2: null });
  });

  it('matches headers case-insensitively', async () => {
    const buffer = await makeXlsxBuffer(['first name', 'LAST NAME'], [['Chidi', 'Nwosu']]);

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows[0]).toMatchObject({ first_name: 'Chidi', last_name: 'Nwosu' });
  });

  it('assigns sequential row_number values, skipping fully blank trailing rows', async () => {
    const buffer = await makeXlsxBuffer(
      ['First Name', 'Last Name'],
      [['Ada', 'Bello'], ['', ''], ['Chidi', 'Nwosu']]
    );

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows.map(r => r.row_number)).toEqual([1, 2]);
    expect(rows[1].first_name).toBe('Chidi');
  });

  it('throws BulkImportParseError when required headers are missing entirely', async () => {
    const buffer = await makeXlsxBuffer(['Email'], [['x@example.com']]);

    await expect(parseBulkImportFile(buffer, 'students.xlsx')).rejects.toThrow(BulkImportParseError);
  });

  it('builds Parent 2 independently of Parent 1', async () => {
    const buffer = await makeXlsxBuffer(
      ['First Name', 'Last Name', 'Parent 2 First Name', 'Parent 2 Last Name', 'Parent 2 Email', 'Parent 2 Relationship', 'Parent 2 Primary Contact (Yes/No)'],
      [['Ada', 'Bello', 'Femi', 'Bello', 'femi@example.com', 'Father', 'Yes']]
    );

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows[0].parent1).toBeNull();
    expect(rows[0].parent2).toMatchObject({ first_name: 'Femi', email: 'femi@example.com', is_primary_contact: true });
  });
});

describe('parseBulkImportFile — .csv', () => {
  it('parses a well-formed CSV file', async () => {
    const buffer = makeCsvBuffer(['First Name', 'Last Name', 'Email'], [['Tunde', 'Okonkwo', 'tunde@example.com']]);

    const rows = await parseBulkImportFile(buffer, 'students.csv');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ first_name: 'Tunde', last_name: 'Okonkwo', email: 'tunde@example.com' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/bulkImportParser.test.ts`
Expected: FAIL with "Cannot find module '../services/bulkImportParser'"

- [ ] **Step 4: Write the implementation**

Create `apps/api/src/services/bulkImportParser.ts`:

```ts
import ExcelJS from 'exceljs';
import { Readable } from 'stream';

export interface ParsedParentRow {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  relationship_type: string | null;
  is_primary_contact: boolean;
}

export interface ParsedStudentRow {
  row_number: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  dob: string | null;
  gender: string | null;
  address: string | null;
  blood_group: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  parent1: ParsedParentRow | null;
  parent2: ParsedParentRow | null;
}

export class BulkImportParseError extends Error {}

const REQUIRED_HEADERS = ['first name', 'last name'];

const COLUMN_MAP: Record<string, string> = {
  'first name': 'first_name',
  'last name': 'last_name',
  'email': 'email',
  'phone': 'phone',
  'date of birth (yyyy-mm-dd)': 'dob',
  'gender': 'gender',
  'address': 'address',
  'blood group': 'blood_group',
  'emergency contact name': 'emergency_contact_name',
  'emergency contact phone': 'emergency_contact_phone',
  'parent 1 first name': 'parent1_first_name',
  'parent 1 last name': 'parent1_last_name',
  'parent 1 email': 'parent1_email',
  'parent 1 phone': 'parent1_phone',
  'parent 1 relationship': 'parent1_relationship_type',
  'parent 1 primary contact (yes/no)': 'parent1_is_primary_contact',
  'parent 2 first name': 'parent2_first_name',
  'parent 2 last name': 'parent2_last_name',
  'parent 2 email': 'parent2_email',
  'parent 2 phone': 'parent2_phone',
  'parent 2 relationship': 'parent2_relationship_type',
  'parent 2 primary contact (yes/no)': 'parent2_is_primary_contact',
};

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'text' in (value as Record<string, unknown>)) {
    return String((value as { text: unknown }).text).trim() || null;
  }
  if (typeof value === 'object' && value !== null && 'result' in (value as Record<string, unknown>)) {
    return String((value as { result: unknown }).result).trim() || null;
  }
  const str = String(value).trim();
  return str === '' ? null : str;
}

function buildParent(raw: Record<string, string | null>, prefix: 'parent1' | 'parent2'): ParsedParentRow | null {
  const first_name = raw[`${prefix}_first_name`] ?? null;
  const last_name = raw[`${prefix}_last_name`] ?? null;
  const email = raw[`${prefix}_email`] ?? null;
  const phone = raw[`${prefix}_phone`] ?? null;
  const relationship_type = raw[`${prefix}_relationship_type`] ?? null;
  const isPrimaryRaw = raw[`${prefix}_is_primary_contact`] ?? null;
  const hasAnyField = !!(first_name || last_name || email || phone || relationship_type || isPrimaryRaw);
  if (!hasAnyField) return null;
  return {
    first_name,
    last_name,
    email,
    phone,
    relationship_type,
    is_primary_contact: !!isPrimaryRaw && /^y(es)?$/i.test(isPrimaryRaw),
  };
}

async function worksheetFromBuffer(buffer: Buffer, filename: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv') {
    return workbook.csv.read(Readable.from(buffer));
  }
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BulkImportParseError('The file has no worksheet.');
  return sheet;
}

export async function parseBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedStudentRow[]> {
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
    throw new BulkImportParseError(`The file is missing required column(s): ${missing.map(h => COLUMN_MAP[h]).join(', ')}`);
  }

  const rows: ParsedStudentRow[] = [];
  let dataRowNumber = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string | null> = {};
    columnIndexToField.forEach((field, colNumber) => {
      raw[field] = cellText(row.getCell(colNumber).value);
    });
    if (!raw.first_name && !raw.last_name) return;

    dataRowNumber += 1;
    rows.push({
      row_number: dataRowNumber,
      first_name: raw.first_name ?? '',
      last_name: raw.last_name ?? '',
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      dob: raw.dob ?? null,
      gender: raw.gender ?? null,
      address: raw.address ?? null,
      blood_group: raw.blood_group ?? null,
      emergency_contact_name: raw.emergency_contact_name ?? null,
      emergency_contact_phone: raw.emergency_contact_phone ?? null,
      parent1: buildParent(raw, 'parent1'),
      parent2: buildParent(raw, 'parent2'),
    });
  });

  return rows;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/bulkImportParser.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json apps/api/src/services/bulkImportParser.ts apps/api/src/__tests__/bulkImportParser.test.ts
git commit -m "feat: add bulk-import file parser for .xlsx and .csv"
```

---

### Task 2: Row validation (`bulkImportValidation.ts`)

**Files:**
- Create: `apps/api/src/services/bulkImportValidation.ts`
- Test: `apps/api/src/__tests__/bulkImportValidation.test.ts`

**Interfaces:**
- Consumes: `ParsedStudentRow`, `ParsedParentRow` from Task 1 (`../services/bulkImportParser`).
- Produces: `RowValidationResult`, `validateRowShape(row: ParsedStudentRow): string[]`, `findDuplicatesWithinFile(rows: ParsedStudentRow[]): Set<number>`, `runFullValidation(rows: ParsedStudentRow[], lookupEmailRoles: (emails: string[]) => Promise<Map<string, string>>): Promise<RowValidationResult[]>` — consumed by Task 4 (preview endpoint) and Task 5 (commit endpoint).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/bulkImportValidation.test.ts`:

```ts
import { validateRowShape, findDuplicatesWithinFile, runFullValidation } from '../services/bulkImportValidation';
import type { ParsedStudentRow } from '../services/bulkImportParser';

function baseRow(overrides: Partial<ParsedStudentRow> = {}): ParsedStudentRow {
  return {
    row_number: 1,
    first_name: 'Tunde',
    last_name: 'Okonkwo',
    email: null,
    phone: null,
    dob: null,
    gender: null,
    address: null,
    blood_group: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    parent1: null,
    parent2: null,
    ...overrides,
  };
}

describe('validateRowShape', () => {
  it('returns no errors for a minimal valid row', () => {
    expect(validateRowShape(baseRow())).toEqual([]);
  });

  it('flags a missing first or last name', () => {
    expect(validateRowShape(baseRow({ first_name: '' }))).toContain('First Name is required.');
    expect(validateRowShape(baseRow({ last_name: '' }))).toContain('Last Name is required.');
  });

  it('flags a malformed student email', () => {
    const errors = validateRowShape(baseRow({ email: 'not-an-email' }));
    expect(errors.some(e => e.includes('not a valid email'))).toBe(true);
  });

  it('flags a malformed date of birth', () => {
    const errors = validateRowShape(baseRow({ dob: '12/25/2015' }));
    expect(errors.some(e => e.includes('YYYY-MM-DD'))).toBe(true);
  });

  it('flags a parent block with fields filled but no email', () => {
    const errors = validateRowShape(baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: null, phone: null, relationship_type: 'Mother', is_primary_contact: false },
    }));
    expect(errors.some(e => e.includes('Parent 1') && e.includes('no email'))).toBe(true);
  });

  it('accepts a fully-formed parent block', () => {
    const errors = validateRowShape(baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    }));
    expect(errors).toEqual([]);
  });
});

describe('findDuplicatesWithinFile', () => {
  it('flags the second occurrence of a repeated student email', () => {
    const rows = [
      baseRow({ row_number: 1, email: 'dupe@example.com' }),
      baseRow({ row_number: 2, email: 'dupe@example.com' }),
    ];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set([2]));
  });

  it('does not flag rows with no email at all', () => {
    const rows = [baseRow({ row_number: 1 }), baseRow({ row_number: 2 })];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set());
  });

  it('is case-insensitive', () => {
    const rows = [
      baseRow({ row_number: 1, email: 'Dupe@Example.com' }),
      baseRow({ row_number: 2, email: 'dupe@example.com' }),
    ];
    expect(findDuplicatesWithinFile(rows)).toEqual(new Set([2]));
  });
});

describe('runFullValidation', () => {
  it('marks a clean row as valid', async () => {
    const results = await runFullValidation([baseRow()], async () => new Map());
    expect(results[0].status).toBe('valid');
    expect(results[0].errors).toEqual([]);
  });

  it('marks a row with a shape error as invalid', async () => {
    const results = await runFullValidation([baseRow({ first_name: '' })], async () => new Map());
    expect(results[0].status).toBe('error');
  });

  it('flags a student email that already belongs to any existing account', async () => {
    const rows = [baseRow({ email: 'taken@example.com' })];
    const results = await runFullValidation(rows, async () => new Map([['taken@example.com', 'teacher']]));
    expect(results[0].status).toBe('error');
    expect(results[0].errors.some(e => e.includes('already registered'))).toBe(true);
  });

  it('flags a parent email that belongs to a non-parent account', async () => {
    const rows = [baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    })];
    const results = await runFullValidation(rows, async () => new Map([['bisi@example.com', 'bursar']]));
    expect(results[0].status).toBe('error');
    expect(results[0].errors.some(e => e.includes('Parent 1') && e.includes('cannot be used'))).toBe(true);
  });

  it('does NOT flag a parent email that already belongs to an existing parent — that is a legitimate reuse', async () => {
    const rows = [baseRow({
      parent1: { first_name: 'Bisi', last_name: 'Okonkwo', email: 'bisi@example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    })];
    const results = await runFullValidation(rows, async () => new Map([['bisi@example.com', 'parent']]));
    expect(results[0].status).toBe('valid');
  });

  it('flags in-file duplicate student emails via runFullValidation end-to-end', async () => {
    const rows = [
      baseRow({ row_number: 1, email: 'dupe@example.com' }),
      baseRow({ row_number: 2, email: 'dupe@example.com' }),
    ];
    const results = await runFullValidation(rows, async () => new Map());
    expect(results[0].status).toBe('valid');
    expect(results[1].status).toBe('error');
    expect(results[1].errors.some(e => e.includes('earlier row'))).toBe(true);
  });

  it('passes the deduplicated, lowercased set of all emails in the file to the lookup function', async () => {
    const rows = [baseRow({
      email: 'Student@Example.com',
      parent1: { first_name: 'A', last_name: 'B', email: 'Parent@Example.com', phone: null, relationship_type: 'Mother', is_primary_contact: false },
    })];
    const lookup = jest.fn().mockResolvedValue(new Map());
    await runFullValidation(rows, lookup);
    expect(lookup).toHaveBeenCalledWith(expect.arrayContaining(['student@example.com', 'parent@example.com']));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/bulkImportValidation.test.ts`
Expected: FAIL with "Cannot find module '../services/bulkImportValidation'"

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/bulkImportValidation.ts`:

```ts
import type { ParsedStudentRow, ParsedParentRow } from './bulkImportParser';

export interface RowValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  student: ParsedStudentRow;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateParent(parent: ParsedParentRow, label: string): string[] {
  const errors: string[] = [];
  if (!parent.email) {
    errors.push(`${label} has other fields filled in but no email — email is required for a parent contact.`);
    return errors;
  }
  if (!EMAIL_PATTERN.test(parent.email)) {
    errors.push(`${label} email "${parent.email}" is not a valid email address.`);
  }
  if (!parent.first_name || !parent.last_name) {
    errors.push(`${label} is missing a first or last name.`);
  }
  if (!parent.relationship_type) {
    errors.push(`${label} is missing a relationship (e.g. Father, Mother, Guardian).`);
  }
  return errors;
}

export function validateRowShape(row: ParsedStudentRow): string[] {
  const errors: string[] = [];
  if (!row.first_name) errors.push('First Name is required.');
  if (!row.last_name) errors.push('Last Name is required.');
  if (row.email && !EMAIL_PATTERN.test(row.email)) errors.push(`Student email "${row.email}" is not a valid email address.`);
  if (row.dob && !DATE_PATTERN.test(row.dob)) errors.push(`Date of Birth "${row.dob}" must be in YYYY-MM-DD format.`);
  if (row.parent1) errors.push(...validateParent(row.parent1, 'Parent 1'));
  if (row.parent2) errors.push(...validateParent(row.parent2, 'Parent 2'));
  return errors;
}

/** Row numbers (1-indexed data rows) that repeat an earlier row's non-blank student email. */
export function findDuplicatesWithinFile(rows: ParsedStudentRow[]): Set<number> {
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
 * layer wires it to a real query, tests wire it to a stub.
 */
export async function runFullValidation(
  rows: ParsedStudentRow[],
  lookupEmailRoles: (emails: string[]) => Promise<Map<string, string>>
): Promise<RowValidationResult[]> {
  const duplicateRowNumbers = findDuplicatesWithinFile(rows);

  const allEmails = new Set<string>();
  for (const row of rows) {
    if (row.email) allEmails.add(row.email.toLowerCase());
    if (row.parent1?.email) allEmails.add(row.parent1.email.toLowerCase());
    if (row.parent2?.email) allEmails.add(row.parent2.email.toLowerCase());
  }
  const existingRoles = allEmails.size > 0 ? await lookupEmailRoles([...allEmails]) : new Map<string, string>();

  return rows.map(row => {
    const errors = validateRowShape(row);

    if (duplicateRowNumbers.has(row.row_number)) {
      errors.push('This student email also appears in an earlier row of this file.');
    }

    if (row.email) {
      const existingRole = existingRoles.get(row.email.toLowerCase());
      if (existingRole) {
        errors.push(`Student email "${row.email}" is already registered to an existing ${existingRole} account.`);
      }
    }

    (['parent1', 'parent2'] as const).forEach(key => {
      const parent = row[key];
      const label = key === 'parent1' ? 'Parent 1' : 'Parent 2';
      if (!parent?.email) return;
      const existingRole = existingRoles.get(parent.email.toLowerCase());
      if (existingRole && existingRole !== 'parent') {
        errors.push(`${label} email "${parent.email}" already belongs to an existing ${existingRole} account and cannot be used as a parent contact.`);
      }
    });

    return {
      row_number: row.row_number,
      status: errors.length === 0 ? 'valid' as const : 'error' as const,
      errors,
      student: row,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/bulkImportValidation.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/bulkImportValidation.ts apps/api/src/__tests__/bulkImportValidation.test.ts
git commit -m "feat: add bulk-import row validation"
```

---

### Task 3: Batched email-conflict lookup query

**Files:**
- Modify: `apps/api/src/db/queries/students.ts` (add one export at the end of the file)
- Test: `apps/api/src/__tests__/studentsQueries.test.ts` (add to the existing file)

**Interfaces:**
- Produces: `findUsersRolesByEmails(emails: string[]): Promise<Map<string, string>>` — consumed by Task 4 and Task 5 (passed as the `lookupEmailRoles` argument to `runFullValidation`).

- [ ] **Step 1: Write the failing test**

Add to the bottom of `apps/api/src/__tests__/studentsQueries.test.ts` (below the existing tests, using the same `pool.query` mock already set up at the top of that file):

```ts
import { findUsersRolesByEmails } from '../db/queries/students';

describe('findUsersRolesByEmails', () => {
  it('returns an empty map without querying when given no emails', async () => {
    const result = await findUsersRolesByEmails([]);
    expect(result).toEqual(new Map());
    expect((pool as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });

  it('returns a lowercase-email-to-role map from the query results', async () => {
    (pool as unknown as { query: jest.Mock }).query.mockResolvedValueOnce({
      rows: [{ email: 'Taken@Example.com', role: 'teacher' }],
    });

    const result = await findUsersRolesByEmails(['taken@example.com', 'free@example.com']);

    expect(result.get('taken@example.com')).toBe('teacher');
    expect(result.has('free@example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/__tests__/studentsQueries.test.ts -t "findUsersRolesByEmails"`
Expected: FAIL with "findUsersRolesByEmails is not a function" (or similar import error)

- [ ] **Step 3: Write the implementation**

Add to the end of `apps/api/src/db/queries/students.ts`:

```ts
// ── Bulk import support ──────────────────────────────────────────────────────

/** Maps each already-registered email (lowercased) to its role, for the
 *  subset of the given emails that exist in `users`. Platform-wide, not
 *  school-scoped — `users.email` has a global UNIQUE constraint. */
export async function findUsersRolesByEmails(emails: string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const result = await pool.query<{ email: string; role: string }>(
    `SELECT email, role FROM users WHERE LOWER(email) = ANY($1::text[])`,
    [emails.map(e => e.toLowerCase())]
  );
  return new Map(result.rows.map(r => [r.email.toLowerCase(), r.role]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/__tests__/studentsQueries.test.ts -t "findUsersRolesByEmails"`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full studentsQueries suite to confirm nothing else broke**

Run: `cd apps/api && npx jest src/__tests__/studentsQueries.test.ts`
Expected: PASS (all tests, existing + new)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/queries/students.ts apps/api/src/__tests__/studentsQueries.test.ts
git commit -m "feat: add findUsersRolesByEmails query for bulk-import validation"
```

---

### Task 4: Preview endpoint

**Files:**
- Modify: `apps/api/src/routes/students.ts`
- Test: `apps/api/tests/studentsBulkImport.test.ts` (new file — DB-integration style, matching `apps/api/tests/payoutSettings.test.ts` conventions)

**Interfaces:**
- Consumes: `parseBulkImportFile`, `BulkImportParseError` (Task 1); `runFullValidation` (Task 2); `findUsersRolesByEmails` (Task 3).
- Produces: `POST /:schoolId/students/bulk-import/preview` — consumed by the frontend in Task 6.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/studentsBulkImport.test.ts`:

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
import studentsRouter from '../src/routes/students';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
app.use('/api/schools', studentsRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function xlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

describe('POST /:schoolId/students/bulk-import/preview', () => {
  let schoolId: string;
  let registrarToken: string;
  let teacherToken: string;
  let existingTeacherEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Bulk Import Preview Test School', `test-bulk-preview-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING id, email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    existingTeacherEmail = teacherResult.rows[0].email;
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    await pool.end();
  }, 30000);

  it('rejects a teacher with 403', async () => {
    const buffer = await xlsxBuffer(['First Name', 'Last Name'], [['Ada', 'Bello']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .attach('file', buffer, 'students.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid row as "valid" and writes nothing to the database', async () => {
    const email = `new-student-${randomUUID()}@test.com`;
    const buffer = await xlsxBuffer(['First Name', 'Last Name', 'Email'], [['Ada', 'Bello', email]]);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(res.body.data.rows[0].status).toBe('valid');

    const row = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    expect(row.rows).toHaveLength(0);
  });

  it('previews a row with a student email conflict as "error"', async () => {
    const buffer = await xlsxBuffer(['First Name', 'Last Name', 'Email'], [['Existing', 'Teacher', existingTeacherEmail]]);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('already registered');
  });

  it('rejects a file with no recognizable header row', async () => {
    const buffer = await xlsxBuffer(['Wrong Column'], [['x']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a file with more than 200 rows', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => [`Student${i}`, 'Test']);
    const buffer = await xlsxBuffer(['First Name', 'Last Name'], rows);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/studentsBulkImport.test.ts`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 3: Add imports to `apps/api/src/routes/students.ts`**

At the top of the file, extend the existing imports:

```ts
import {
  registerStudent,
  listStudents,
  getStudentProfile,
  updateStudentBio,
  updateStudentPhotoUrl,
  findStudentById,
  findEnrollmentForSession,
  insertStudentClass,
  findEnrollmentForCurrentSession,
  updateEnrollmentClass,
  findUsersRolesByEmails,
} from '../db/queries/students';
import { parseBulkImportFile, BulkImportParseError } from '../services/bulkImportParser';
import { runFullValidation } from '../services/bulkImportValidation';
```

- [ ] **Step 4: Add the preview route**

Insert immediately after the existing `POST /:schoolId/students` route (after its closing `);` around line 223) in `apps/api/src/routes/students.ts`:

```ts
// ── POST /:schoolId/students/bulk-import/preview ────────────────────────────────
// Parses and validates a spreadsheet without writing anything — the registrar
// confirms via /bulk-import/commit afterward. See docs/superpowers/specs/
// 2026-08-19-student-bulk-import-design.md for the full design rationale.

const MAX_BULK_IMPORT_ROWS = 200;
const bulkImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post(
  '/:schoolId/students/bulk-import/preview',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  bulkImportUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

      let parsedRows;
      try {
        parsedRows = await parseBulkImportFile(file.buffer, file.originalname);
      } catch (err) {
        if (err instanceof BulkImportParseError) {
          return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: err.message } });
        }
        throw err;
      }

      if (parsedRows.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'No student rows were found in this file.' } });
      }
      if (parsedRows.length > MAX_BULK_IMPORT_ROWS) {
        return res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_ROWS', message: `This file has ${parsedRows.length} rows — the maximum per import is ${MAX_BULK_IMPORT_ROWS}. Split it into multiple files.` },
        });
      }

      const results = await runFullValidation(parsedRows, findUsersRolesByEmails);
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

Run: `cd apps/api && npx jest tests/studentsBulkImport.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/students.ts apps/api/tests/studentsBulkImport.test.ts
git commit -m "feat: add bulk-import preview endpoint for students"
```

---

### Task 5: Results file generator + commit endpoint

**Files:**
- Create: `apps/api/src/services/bulkImportResults.ts`
- Modify: `apps/api/src/routes/students.ts`
- Modify: `apps/api/tests/studentsBulkImport.test.ts` (add a new `describe` block)

**Interfaces:**
- Produces (from `bulkImportResults.ts`): `CreatedStudentRecord`, `CreatedParentRecord`, `generateBulkImportResultsFile(createdStudents: CreatedStudentRecord[], newParents: CreatedParentRecord[]): Promise<Buffer>`.
- Produces (from the route): `POST /:schoolId/students/bulk-import/commit` — consumed by the frontend in Task 6.
- Consumes: `registerStudent()` (existing, `../db/queries/students`), `runFullValidation` (Task 2), `findUsersRolesByEmails` (Task 3), `sendEmail`, `welcomeEmailBody`, `getSchoolName`, `logAudit` (all already imported/defined in `students.ts`).

- [ ] **Step 1: Write the failing unit test for the results file generator**

Create `apps/api/src/__tests__/bulkImportResults.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { generateBulkImportResultsFile } from '../services/bulkImportResults';

describe('generateBulkImportResultsFile', () => {
  it('produces a workbook with Summary, Students Created, and New Parent Accounts sheets', async () => {
    const buffer = await generateBulkImportResultsFile(
      [{ row_number: 1, first_name: 'Ada', last_name: 'Bello', admission_no: 'SCH/2026/0001', email: 'ada@school.internal' }],
      [{ first_name: 'Bisi', last_name: 'Bello', email: 'bisi@example.com' }]
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Students Created', 'New Parent Accounts']);

    const studentsSheet = workbook.getWorksheet('Students Created')!;
    expect(studentsSheet.getRow(2).getCell(4).value).toBe('SCH/2026/0001');

    const parentsSheet = workbook.getWorksheet('New Parent Accounts')!;
    expect(parentsSheet.getRow(2).getCell(3).value).toBe('bisi@example.com');
  });

  it('mentions the fixed password once in the Summary sheet', async () => {
    const buffer = await generateBulkImportResultsFile([], []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const summarySheet = workbook.getWorksheet('Summary')!;
    const allText = [1, 2, 3].map(n => String(summarySheet.getRow(n).getCell(1).value ?? '')).join(' ');
    expect(allText).toContain('Password2$');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/__tests__/bulkImportResults.test.ts`
Expected: FAIL with "Cannot find module '../services/bulkImportResults'"

- [ ] **Step 3: Write the results file generator**

Create `apps/api/src/services/bulkImportResults.ts`:

```ts
import ExcelJS from 'exceljs';

export interface CreatedStudentRecord {
  row_number: number;
  first_name: string;
  last_name: string;
  admission_no: string;
  email: string;
}

export interface CreatedParentRecord {
  first_name: string;
  last_name: string;
  email: string;
}

export async function generateBulkImportResultsFile(
  createdStudents: CreatedStudentRecord[],
  newParents: CreatedParentRecord[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Bulk Import Results']);
  summary.addRow([`${createdStudents.length} student(s) and ${newParents.length} new parent account(s) created.`]);
  summary.addRow(['All accounts use the temporary password Password2$ — users are required to change it on first login.']);

  const studentsSheet = workbook.addWorksheet('Students Created');
  studentsSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'First Name', key: 'first_name', width: 20 },
    { header: 'Last Name', key: 'last_name', width: 20 },
    { header: 'Admission No.', key: 'admission_no', width: 20 },
    { header: 'Email', key: 'email', width: 32 },
  ];
  createdStudents.forEach(s => studentsSheet.addRow(s));

  const parentsSheet = workbook.addWorksheet('New Parent Accounts');
  parentsSheet.columns = [
    { header: 'First Name', key: 'first_name', width: 20 },
    { header: 'Last Name', key: 'last_name', width: 20 },
    { header: 'Email', key: 'email', width: 32 },
  ];
  newParents.forEach(p => parentsSheet.addRow(p));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/__tests__/bulkImportResults.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing integration test for the commit endpoint**

Add to `apps/api/tests/studentsBulkImport.test.ts`, in a new `describe` block below the existing one (reusing the same `app`, `makeToken`, `xlsxBuffer` helpers already defined in that file — do not redeclare them):

```ts
describe('POST /:schoolId/students/bulk-import/commit', () => {
  let schoolId: string;
  let registrarToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Bulk Import Commit Test School', `test-bulk-commit-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-commit-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING id, email`,
      [schoolId, `teacher-commit-${randomUUID()}@test.com`]
    );
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(token: string, buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, 'students.xlsx');
    return res.body.data.rows;
  }

  it('rejects a teacher with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ rows: [] });
    expect(res.status).toBe(403);
  });

  it('creates students and a new parent, sets the fixed password, and returns a downloadable results file', async () => {
    const studentEmail = `commit-student-${randomUUID()}@test.com`;
    const parentEmail = `commit-parent-${randomUUID()}@test.com`;
    const buffer = await xlsxBuffer(
      ['First Name', 'Last Name', 'Email', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Relationship'],
      [['Ada', 'Bello', studentEmail, 'Bisi', 'Bello', parentEmail, 'Mother']]
    );
    const rows = await preview(registrarToken, buffer);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.failed).toBe(0);
    expect(typeof res.body.data.download_base64).toBe('string');

    const studentRow = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE email = $1`, [studentEmail]);
    expect(studentRow.rows).toHaveLength(1);

    const bcrypt = require('bcryptjs');
    expect(bcrypt.compareSync('Password2$', studentRow.rows[0].password_hash)).toBe(true);

    const parentRow = await pool.query(`SELECT id FROM users WHERE email = $1 AND role = 'parent'`, [parentEmail]);
    expect(parentRow.rows).toHaveLength(1);
  });

  it('reuses an existing parent by email instead of creating a duplicate, for two siblings in the same file', async () => {
    const sharedParentEmail = `shared-parent-${randomUUID()}@test.com`;
    const buffer = await xlsxBuffer(
      ['First Name', 'Last Name', 'Email', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Relationship'],
      [
        ['Sibling', 'One', `sib1-${randomUUID()}@test.com`, 'Shared', 'Parent', sharedParentEmail, 'Father'],
        ['Sibling', 'Two', `sib2-${randomUUID()}@test.com`, 'Shared', 'Parent', sharedParentEmail, 'Father'],
      ]
    );
    const rows = await preview(registrarToken, buffer);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);

    const parentRows = await pool.query(`SELECT id FROM users WHERE email = $1`, [sharedParentEmail]);
    expect(parentRows.rows).toHaveLength(1); // one parent account, not two
  });

  it('does not roll back other rows when one row fails at commit time', async () => {
    const goodEmail = `good-${randomUUID()}@test.com`;
    const conflictEmail = `will-conflict-${randomUUID()}@test.com`;

    // Pre-create a user with conflictEmail directly in the DB, AFTER preview
    // would have run, to simulate a race between preview and commit.
    const buffer = await xlsxBuffer(
      ['First Name', 'Last Name', 'Email'],
      [['Good', 'Row', goodEmail], ['Conflict', 'Row', conflictEmail]]
    );
    const rows = await preview(registrarToken, buffer);

    await pool.query(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Snuck', 'In', 'subject')`,
      [schoolId, conflictEmail]
    );

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.failed).toBe(1);

    const goodRow = await pool.query(`SELECT id FROM users WHERE email = $1`, [goodEmail]);
    expect(goodRow.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/studentsBulkImport.test.ts -t "commit"`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 7: Add imports and the commit route to `apps/api/src/routes/students.ts`**

Extend the imports at the top of the file:

```ts
import { generateBulkImportResultsFile, type CreatedStudentRecord, type CreatedParentRecord } from '../services/bulkImportResults';
```

Insert immediately after the preview route added in Task 4:

```ts
// ── POST /:schoolId/students/bulk-import/commit ─────────────────────────────────
// Re-validates every row from scratch — never trusts the client-supplied
// "valid"/"error" status from preview. One registerStudent() transaction per
// row, so a single bad row can't roll back the rest of the batch.

const BULK_IMPORT_PASSWORD = 'Password2$';
const BULK_IMPORT_EMAIL_BATCH_SIZE = 50;

const bulkImportParentSchema = z.object({
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  relationship_type: z.string().nullable(),
  is_primary_contact: z.boolean(),
});

const bulkImportCommitSchema = z.object({
  rows: z.array(z.object({
    row_number: z.number(),
    status: z.enum(['valid', 'error']),
    errors: z.array(z.string()),
    student: z.object({
      row_number: z.number(),
      first_name: z.string(),
      last_name: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      dob: z.string().nullable(),
      gender: z.string().nullable(),
      address: z.string().nullable(),
      blood_group: z.string().nullable(),
      emergency_contact_name: z.string().nullable(),
      emergency_contact_phone: z.string().nullable(),
      parent1: bulkImportParentSchema.nullable(),
      parent2: bulkImportParentSchema.nullable(),
    }),
  })).min(1).max(MAX_BULK_IMPORT_ROWS),
});

router.post(
  '/:schoolId/students/bulk-import/commit',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal', 'registrar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = bulkImportCommitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const submittedRows = parsed.data.rows.map(r => r.student);
      const revalidated = await runFullValidation(submittedRows, findUsersRolesByEmails);

      const passwordHash = hashSync(BULK_IMPORT_PASSWORD, 12);
      const results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string; admission_no?: string }> = [];
      const createdStudents: CreatedStudentRecord[] = [];
      const allNewParents: CreatedParentRecord[] = [];

      for (const row of revalidated) {
        if (row.status === 'error') {
          results.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') });
          continue;
        }

        const student = row.student;
        const parentsInput = [student.parent1, student.parent2]
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .map(p => ({
            email: p.email!,
            first_name: p.first_name ?? '',
            last_name: p.last_name ?? '',
            phone: p.phone ?? undefined,
            relationship_type: p.relationship_type ?? '',
            is_primary_contact: p.is_primary_contact,
            passwordHash,
            tempPassword: BULK_IMPORT_PASSWORD,
          }));

        try {
          const result = await registerStudent(
            req.params.schoolId,
            {
              first_name: student.first_name,
              last_name: student.last_name,
              email: student.email ?? undefined,
              phone: student.phone ?? undefined,
              dob: student.dob,
              gender: student.gender,
              address: student.address,
              blood_group: student.blood_group,
              emergency_contact_name: student.emergency_contact_name,
              emergency_contact_phone: student.emergency_contact_phone,
              passwordHash,
            },
            parentsInput
          );

          results.push({ row_number: row.row_number, status: 'created', admission_no: result.admission_no });
          createdStudents.push({
            row_number: row.row_number,
            first_name: student.first_name,
            last_name: student.last_name,
            admission_no: result.admission_no,
            email: result.student.email,
          });
          for (const p of result.new_parents) {
            const source = parentsInput.find(pi => pi.email === p.email);
            allNewParents.push({
              first_name: source?.first_name ?? '',
              last_name: source?.last_name ?? '',
              email: p.email,
            });
          }
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'An account with this email already exists.'
            : 'Failed to create this record.';
          results.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }

      if (allNewParents.length > 0) {
        const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
        getSchoolName(req.params.schoolId).then(async schoolName => {
          for (let i = 0; i < allNewParents.length; i += BULK_IMPORT_EMAIL_BATCH_SIZE) {
            const batch = allNewParents.slice(i, i + BULK_IMPORT_EMAIL_BATCH_SIZE);
            await Promise.all(
              batch.map(p => sendEmail(
                p.email,
                'Welcome to Chronix Edu — Your Parent Portal Access',
                welcomeEmailBody('parent', `${p.first_name} ${p.last_name}`, p.email, BULK_IMPORT_PASSWORD, schoolName, appUrl)
              ).catch(() => {}))
            );
            if (i + BULK_IMPORT_EMAIL_BATCH_SIZE < allNewParents.length) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }).catch(() => {});
      }

      const resultsFile = await generateBulkImportResultsFile(createdStudents, allNewParents);

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'STUDENTS_BULK_IMPORT',
        entity: 'students',
        entityId: req.params.schoolId,
        newValue: { created: createdStudents.length, failed: results.filter(r => r.status === 'failed').length },
      });

      return res.json({
        success: true,
        data: {
          created: createdStudents.length,
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

Run: `cd apps/api && npx jest tests/studentsBulkImport.test.ts`
Expected: PASS (all tests in the file — preview + commit describe blocks)

- [ ] **Step 9: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/bulkImportResults.ts apps/api/src/__tests__/bulkImportResults.test.ts apps/api/src/routes/students.ts apps/api/tests/studentsBulkImport.test.ts
git commit -m "feat: add bulk-import commit endpoint and results file generator"
```

---

### Task 6: Frontend — template asset + the import page

**Files:**
- Create: `apps/web/public/templates/student-bulk-import-template.xlsx` (generated once via a temporary script, then committed as a static asset — not regenerated at runtime)
- Create: `apps/web/app/(dashboard)/registrar/students/import/page.tsx`

**Interfaces:**
- Consumes: `POST /:schoolId/students/bulk-import/preview` and `POST /:schoolId/students/bulk-import/commit` (Tasks 4 and 5) via `apiUpload`/`apiFetch` (`apps/web/lib/api.ts`, existing).

- [ ] **Step 1: Generate the template file**

Create a temporary script at the repo root, `_gen-template.js` (this file is deleted in Step 3 — it is not part of the final commit):

```js
const ExcelJS = require('exceljs');

async function main() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Students');
  sheet.columns = [
    { header: 'First Name', key: 'first_name', width: 16 },
    { header: 'Last Name', key: 'last_name', width: 16 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Date of Birth (YYYY-MM-DD)', key: 'dob', width: 22 },
    { header: 'Gender', key: 'gender', width: 12 },
    { header: 'Address', key: 'address', width: 30 },
    { header: 'Blood Group', key: 'blood_group', width: 14 },
    { header: 'Emergency Contact Name', key: 'ec_name', width: 24 },
    { header: 'Emergency Contact Phone', key: 'ec_phone', width: 22 },
    { header: 'Parent 1 First Name', key: 'p1fn', width: 18 },
    { header: 'Parent 1 Last Name', key: 'p1ln', width: 18 },
    { header: 'Parent 1 Email', key: 'p1email', width: 26 },
    { header: 'Parent 1 Phone', key: 'p1phone', width: 16 },
    { header: 'Parent 1 Relationship', key: 'p1rel', width: 18 },
    { header: 'Parent 1 Primary Contact (Yes/No)', key: 'p1primary', width: 26 },
    { header: 'Parent 2 First Name', key: 'p2fn', width: 18 },
    { header: 'Parent 2 Last Name', key: 'p2ln', width: 18 },
    { header: 'Parent 2 Email', key: 'p2email', width: 26 },
    { header: 'Parent 2 Phone', key: 'p2phone', width: 16 },
    { header: 'Parent 2 Relationship', key: 'p2rel', width: 18 },
    { header: 'Parent 2 Primary Contact (Yes/No)', key: 'p2primary', width: 26 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
  sheet.addRow({
    first_name: 'Ada', last_name: 'Bello', email: '', phone: '', dob: '2015-03-12', gender: 'Female',
    address: '', blood_group: '', ec_name: '', ec_phone: '',
    p1fn: 'Chidi', p1ln: 'Bello', p1email: 'chidi.bello@example.com', p1phone: '', p1rel: 'Father', p1primary: 'Yes',
    p2fn: '', p2ln: '', p2email: '', p2phone: '', p2rel: '', p2primary: '',
  });

  await wb.xlsx.writeFile(process.argv[2]);
  console.log('Template written to', process.argv[2]);
}

main();
```

Run (from repo root, where `exceljs` is resolvable via workspace hoisting from `apps/api`'s install in Task 1):

```bash
mkdir -p apps/web/public/templates
node _gen-template.js apps/web/public/templates/student-bulk-import-template.xlsx
```

- [ ] **Step 2: Verify the template manually**

Open `apps/web/public/templates/student-bulk-import-template.xlsx` and confirm: 21 columns matching the list in Step 1, header row styled, one example row present.

- [ ] **Step 3: Delete the temporary script**

```bash
rm _gen-template.js
```

- [ ] **Step 4: Write the import page**

Create `apps/web/app/(dashboard)/registrar/students/import/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RowParent {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

interface RowValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  student: {
    first_name: string;
    last_name: string;
    email: string | null;
    parent1: RowParent | null;
    parent2: RowParent | null;
  };
}

interface CommitResult {
  created: number;
  failed: number;
  results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string; admission_no?: string }>;
  download_base64: string;
}

type Step = 'upload' | 'preview' | 'done';

function parentSummary(student: RowValidationResult['student']): string {
  const names = [student.parent1, student.parent2]
    .filter((p): p is RowParent => !!p)
    .map(p => `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim())
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : '—';
}

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

export default function StudentBulkImportPage() {
  const { schoolId } = useAuth();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [rows, setRows] = useState<RowValidationResult[]>([]);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [commitError, setCommitError] = useState('');

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !file) return;
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiUpload<{ success: boolean; data: { rows: RowValidationResult[] } }>(
        `/api/schools/${schoolId}/students/bulk-import/preview`,
        formData
      );
      setRows(res.data.rows);
      setStep('preview');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to process this file');
    } finally {
      setUploading(false);
    }
  }

  async function handleCommit() {
    if (!schoolId) return;
    setCommitting(true);
    setCommitError('');
    try {
      const validRows = rows.filter(r => r.status === 'valid');
      const res = await apiFetch<{ success: boolean; data: CommitResult }>(
        `/api/schools/${schoolId}/students/bulk-import/commit`,
        { method: 'POST', body: JSON.stringify({ rows: validRows }) }
      );
      setCommitResult(res.data);
      setStep('done');
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  const validCount = rows.filter(r => r.status === 'valid').length;
  const invalidCount = rows.length - validCount;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <Link href="/registrar/students" className="text-sm text-[#2472B4] hover:underline">← Back to Students</Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">Bulk Import Students</h1>
        <p className="text-sm text-gray-500 mt-1">Upload a spreadsheet to register up to 200 students (and their parents) at once.</p>
      </div>

      {step === 'upload' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <a
            href="/templates/student-bulk-import-template.xlsx"
            download
            className="inline-block text-sm font-medium text-[#2472B4] hover:underline"
          >
            Download the import template (.xlsx)
          </a>
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

      {step === 'preview' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <p className="text-sm text-gray-700">
              <span className="font-semibold text-green-700">{validCount} of {rows.length} rows valid</span>
              {invalidCount > 0 && <span className="text-red-600"> — {invalidCount} row(s) have errors and will be skipped</span>}
            </p>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs uppercase text-gray-400">
                  <th className="px-4 py-2">Row</th>
                  <th className="px-4 py-2">Student</th>
                  <th className="px-4 py-2">Parent(s)</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(r => (
                  <tr key={r.row_number}>
                    <td className="px-4 py-2 text-gray-500">{r.row_number}</td>
                    <td className="px-4 py-2">{r.student.first_name} {r.student.last_name}</td>
                    <td className="px-4 py-2 text-gray-500">{parentSummary(r.student)}</td>
                    <td className="px-4 py-2">
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
              disabled={validCount === 0 || committing}
              className="px-5 py-2 bg-[#FF761B] text-white text-sm font-medium rounded-lg hover:bg-[#e56812] disabled:opacity-50"
            >
              {committing ? 'Importing…' : `Import ${validCount} valid student${validCount === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              onClick={() => { setStep('upload'); setFile(null); setRows([]); }}
              className="px-5 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <p className="text-lg font-semibold text-gray-900">
            {commitResult.created} student{commitResult.created === 1 ? '' : 's'} created
            {commitResult.failed > 0 && <span className="text-red-600">, {commitResult.failed} failed</span>}
          </p>

          {commitResult.failed > 0 && (
            <div className="space-y-1">
              {commitResult.results.filter(r => r.status === 'failed').map(r => (
                <p key={r.row_number} className="text-sm text-red-700">Row {r.row_number}: {r.reason}</p>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => downloadBase64File(commitResult.download_base64, 'chronix-edu-bulk-import-results.xlsx')}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
          >
            Download results (.xlsx)
          </button>

          <div>
            <Link href="/registrar/students" className="text-sm text-[#2472B4] hover:underline">← Back to Students</Link>
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
git add apps/web/public/templates/student-bulk-import-template.xlsx "apps/web/app/(dashboard)/registrar/students/import/page.tsx"
git commit -m "feat: add student bulk-import page and downloadable template"
```

---

### Task 7: Entry point on the Students page + full manual verification

**Files:**
- Modify: `apps/web/app/(dashboard)/registrar/students/page.tsx`

**Interfaces:**
- Consumes: the page created in Task 6 (`/registrar/students/import`).

- [ ] **Step 1: Add the "Bulk Import" link**

In `apps/web/app/(dashboard)/registrar/students/page.tsx`, find this block (around line 503-514):

```tsx
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">Student Registration</h1>
        <button
          onClick={() => setRegisterOpen(true)}
          className="btn-primary gap-1.5 self-start sm:self-auto"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Register Student
        </button>
      </div>
```

Replace it with:

```tsx
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <h1 className="text-xl font-semibold text-gray-900">Student Registration</h1>
        <div className="flex gap-2 self-start sm:self-auto">
          <Link
            href="/registrar/students/import"
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
          >
            Bulk Import
          </Link>
          <button
            onClick={() => setRegisterOpen(true)}
            className="btn-primary gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Register Student
          </button>
        </div>
      </div>
```

(`Link` is already imported at the top of this file — no new import needed.)

- [ ] **Step 2: Run typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Full backend test suite**

Run: `cd apps/api && npx jest --runInBand`
Expected: all suites pass (existing suites unaffected + all new bulk-import tests from Tasks 1-5)

- [ ] **Step 4: Manual end-to-end verification**

With both `apps/api` and `apps/web` running locally (or against a review deploy):
1. Log in as a registrar/principal/super_admin.
2. Go to Students → **Bulk Import**.
3. Download the template, fill in 2-3 rows (at least one with a parent, one with two parents, one with a deliberately invalid email to confirm the error path).
4. Upload it — confirm the preview table shows the right "Will create" / "Error" verdicts.
5. Click Import — confirm the results summary, download the results `.xlsx`, and open it to confirm it lists the created students/parents and the fixed-password note.
6. Log in as one of the newly created parent accounts using `Password2$` — confirm it's forced to `/change-password` before reaching the dashboard (this exercises the existing `must_change_password` flow from earlier this session, not new code, but confirms bulk-imported accounts actually inherit it).
7. Confirm the same file re-uploaded a second time shows the earlier rows now as "Error: already registered" in preview, rather than silently duplicating them.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(dashboard)/registrar/students/page.tsx"
git commit -m "feat: add Bulk Import entry point to the Students page"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the design spec maps to a task — file parsing (Task 1), validation shared by preview/commit (Task 2), the email-conflict DB check (Task 3), the preview endpoint (Task 4), the commit endpoint + results file + batched welcome emails (Task 5), the template + 3-step frontend page (Task 6), and the Students-page entry point + manual QA pass (Task 7).
- **Type consistency checked:** `ParsedStudentRow`/`ParsedParentRow` (Task 1) flow unchanged into `RowValidationResult` (Task 2), which flows unchanged into the preview response and the commit request schema (Tasks 4-5) and the frontend's `RowValidationResult` type (Task 6) — field names match end to end (`row_number`, `status`, `errors`, `student.parent1`/`parent2`).
- **No placeholders:** every step has real, complete code — no "add validation here" or "similar to Task N" shortcuts.
