# Roster Bulk Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a principal/super_admin upload a single `.xlsx` workbook with three sheets (Classes, Subjects, Teacher Assignments), preview exactly what will be created per sheet (including per-row errors), and commit — creating rows via the same validation rules the existing single-item Roster routes already enforce.

**Architecture:** Two new endpoints on the existing `apps/api/src/routes/roster.ts` router — `POST /:schoolId/roster-bulk-import/preview` (parses + validates all 3 sheets, writes nothing) and `POST /:schoolId/roster-bulk-import/commit` (re-validates from a single fresh snapshot of existing data, then inserts). A new frontend page drives the upload → preview → commit flow, adapted from the Students & Parents import page to show three sections instead of one flat table. Full design rationale lives in `docs/superpowers/specs/2026-08-20-roster-bulk-import-design.md` — read it before starting if anything below is unclear on *why*.

**Tech Stack:** Express + TypeScript + Zod + `pg` (existing), `exceljs` (existing dependency, already used by the Students & Parents bulk import), Next.js 14 App Router (existing frontend conventions).

## Global Constraints

- **`.xlsx` only** — reject any other extension with a clear parse error. No CSV support (a 3-sheet workbook has no CSV equivalent).
- Row cap: **300 rows total across all three sheets combined**, enforced at parse time.
- Teacher Assignment rows resolve **only against pre-existing Classes/Subjects/Teachers** — never against a row created earlier in the same commit. Commit fetches one snapshot of existing classes/subjects/teacher-matches/active-term **before** any inserts happen, and validates every sheet against that single snapshot.
- Commit processes sheets in order: **Classes, then Subjects, then Teacher Assignments.**
- Same role gate as the existing single-item Roster routes everywhere: `requireRole('super_admin', 'principal')` — **registrar is NOT included** (this differs from the Students & Parents import, which does include registrar).
- Commit must re-validate every row from scratch — never trust the row data or `status` field the client sends back from preview.
- One DB insert per row at commit time, wrapped in its own try/catch — one bad row must not block the rest of its sheet or a later sheet.
- No credentials/passwords are involved anywhere in this feature.

---

### Task 1: File parser (`rosterBulkImportParser.ts`)

**Files:**
- Create: `apps/api/src/services/rosterBulkImportParser.ts`
- Test: `apps/api/src/__tests__/rosterBulkImportParser.test.ts`

**Interfaces:**
- Produces: `ParsedClassRow`, `ParsedSubjectRow`, `ParsedAssignmentRow`, `ParsedRosterWorkbook`, `RosterBulkImportParseError`, `parseRosterBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedRosterWorkbook>` — consumed by Task 2 (validation) and Task 3 (preview endpoint).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/rosterBulkImportParser.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { parseRosterBulkImportFile, RosterBulkImportParseError } from '../services/rosterBulkImportParser';

async function makeWorkbookBuffer(sheets: { name: string; headers: string[]; rows: (string | number)[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = workbook.addWorksheet(s.name);
    sheet.addRow(s.headers);
    s.rows.forEach(r => sheet.addRow(r));
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const CLASS_HEADERS = ['Name', 'Level', 'Stream', 'Form Teacher Email'];
const SUBJECT_HEADERS = ['Name', 'Code'];
const ASSIGNMENT_HEADERS = ['Teacher Email', 'Class Name', 'Subject Code'];

function emptySheets(overrides: Partial<Record<'Classes' | 'Subjects' | 'Teacher Assignments', (string | number)[][]>> = {}) {
  return [
    { name: 'Classes', headers: CLASS_HEADERS, rows: overrides['Classes'] ?? [] },
    { name: 'Subjects', headers: SUBJECT_HEADERS, rows: overrides['Subjects'] ?? [] },
    { name: 'Teacher Assignments', headers: ASSIGNMENT_HEADERS, rows: overrides['Teacher Assignments'] ?? [] },
  ];
}

describe('parseRosterBulkImportFile', () => {
  it('rejects a non-.xlsx filename', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets());
    await expect(parseRosterBulkImportFile(buffer, 'roster.csv')).rejects.toThrow(RosterBulkImportParseError);
  });

  it('parses a well-formed Classes row', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['JSS 1A', 'JSS1', '', 'chidi@example.com']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]).toMatchObject({
      row_number: 2,
      name: 'JSS 1A',
      level: 'JSS1',
      stream: null,
      form_teacher_email: 'chidi@example.com',
    });
  });

  it('lowercases form_teacher_email and teacher_email, uppercases subject/assignment codes', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['JSS 1A', 'JSS1', '', 'Chidi@Example.COM']],
      Subjects: [['Mathematics', 'mth']],
      'Teacher Assignments': [['Chidi@Example.COM', 'JSS 1A', 'mth']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes[0].form_teacher_email).toBe('chidi@example.com');
    expect(result.subjects[0].code).toBe('MTH');
    expect(result.assignments[0].teacher_email).toBe('chidi@example.com');
    expect(result.assignments[0].subject_code).toBe('MTH');
  });

  it('assigns the real sheet row number and skips fully blank rows without compacting', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['JSS 1A', 'JSS1', '', ''], ['', '', '', ''], ['JSS 1B', 'JSS1', '', '']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes.map(c => c.row_number)).toEqual([2, 4]);
  });

  it('does not drop a row that has content but is missing a required field', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['', 'JSS1', '', '']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]).toMatchObject({ name: '', level: 'JSS1' });
  });

  it('parses Subjects and Teacher Assignments sheets independently of Classes', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Subjects: [['Mathematics', 'MTH'], ['English Language', 'ENG']],
      'Teacher Assignments': [['teacher@example.com', 'JSS 1A', 'MTH']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.subjects).toHaveLength(2);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({
      row_number: 2,
      teacher_email: 'teacher@example.com',
      class_name: 'JSS 1A',
      subject_code: 'MTH',
    });
  });

  it('throws RosterBulkImportParseError when a required sheet is missing entirely', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(CLASS_HEADERS);
    // Subjects and Teacher Assignments sheets absent entirely.
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await expect(parseRosterBulkImportFile(buffer, 'roster.xlsx')).rejects.toThrow(RosterBulkImportParseError);
  });

  it('throws RosterBulkImportParseError when the Classes sheet is missing a required column', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(['Name']); // missing Level
    workbook.addWorksheet('Subjects').addRow(SUBJECT_HEADERS);
    workbook.addWorksheet('Teacher Assignments').addRow(ASSIGNMENT_HEADERS);
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await expect(parseRosterBulkImportFile(buffer, 'roster.xlsx')).rejects.toThrow(RosterBulkImportParseError);
  });

  it('matches headers case-insensitively', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(['name', 'LEVEL', 'stream', 'form teacher email']);
    workbook.getWorksheet('Classes')!.addRow(['JSS 1A', 'JSS1', '', '']);
    workbook.addWorksheet('Subjects').addRow(SUBJECT_HEADERS);
    workbook.addWorksheet('Teacher Assignments').addRow(ASSIGNMENT_HEADERS);
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes[0]).toMatchObject({ name: 'JSS 1A', level: 'JSS1' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/rosterBulkImportParser.test.ts`
Expected: FAIL with "Cannot find module '../services/rosterBulkImportParser'"

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/rosterBulkImportParser.ts`:

```ts
import ExcelJS from 'exceljs';

export interface ParsedClassRow {
  row_number: number;
  name: string;
  level: string;
  stream: string | null;
  form_teacher_email: string | null;
}

export interface ParsedSubjectRow {
  row_number: number;
  name: string;
  code: string;
}

export interface ParsedAssignmentRow {
  row_number: number;
  teacher_email: string;
  class_name: string;
  subject_code: string;
}

export interface ParsedRosterWorkbook {
  classes: ParsedClassRow[];
  subjects: ParsedSubjectRow[];
  assignments: ParsedAssignmentRow[];
}

export class RosterBulkImportParseError extends Error {}

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

/** Shared row-extraction for all three sheets — same header-matching,
 *  blank-row-skipping, and real-sheet-row-numbering rules apply to each. */
function parseSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  columnMap: Record<string, string>,
  requiredFields: string[]
): Record<string, string | null>[] {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new RosterBulkImportParseError(`The file is missing the required "${sheetName}" sheet.`);
  }

  const headerRow = sheet.getRow(1);
  const columnIndexToField = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellText(cell.value)?.toLowerCase();
    if (header && columnMap[header]) {
      columnIndexToField.set(colNumber, columnMap[header]);
    }
  });

  const foundFields = new Set(columnIndexToField.values());
  const missing = requiredFields.filter(f => !foundFields.has(f));
  if (missing.length > 0) {
    throw new RosterBulkImportParseError(`The "${sheetName}" sheet is missing required column(s): ${missing.join(', ')}`);
  }

  const rows: Record<string, string | null>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string | null> = {};
    columnIndexToField.forEach((field, colNumber) => {
      raw[field] = cellText(row.getCell(colNumber).value);
    });
    const hasAnyContent = Object.values(raw).some(v => v !== null);
    if (!hasAnyContent) return;
    raw.row_number = String(rowNumber);
    rows.push(raw);
  });

  return rows;
}

const CLASS_COLUMN_MAP: Record<string, string> = {
  'name': 'name',
  'level': 'level',
  'stream': 'stream',
  'form teacher email': 'form_teacher_email',
};

const SUBJECT_COLUMN_MAP: Record<string, string> = {
  'name': 'name',
  'code': 'code',
};

const ASSIGNMENT_COLUMN_MAP: Record<string, string> = {
  'teacher email': 'teacher_email',
  'class name': 'class_name',
  'subject code': 'subject_code',
};

export async function parseRosterBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedRosterWorkbook> {
  if (!filename.toLowerCase().endsWith('.xlsx')) {
    throw new RosterBulkImportParseError('Only .xlsx files are supported for Roster bulk import.');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const classRaws = parseSheet(workbook, 'Classes', CLASS_COLUMN_MAP, ['name', 'level']);
  const subjectRaws = parseSheet(workbook, 'Subjects', SUBJECT_COLUMN_MAP, ['name', 'code']);
  const assignmentRaws = parseSheet(workbook, 'Teacher Assignments', ASSIGNMENT_COLUMN_MAP, ['teacher_email', 'class_name', 'subject_code']);

  const classes: ParsedClassRow[] = classRaws.map(raw => ({
    row_number: Number(raw.row_number),
    name: raw.name ?? '',
    level: raw.level ?? '',
    stream: raw.stream ?? null,
    form_teacher_email: raw.form_teacher_email ? raw.form_teacher_email.toLowerCase() : null,
  }));

  const subjects: ParsedSubjectRow[] = subjectRaws.map(raw => ({
    row_number: Number(raw.row_number),
    name: raw.name ?? '',
    code: raw.code ? raw.code.toUpperCase() : '',
  }));

  const assignments: ParsedAssignmentRow[] = assignmentRaws.map(raw => ({
    row_number: Number(raw.row_number),
    teacher_email: raw.teacher_email ? raw.teacher_email.toLowerCase() : '',
    class_name: raw.class_name ?? '',
    subject_code: raw.subject_code ? raw.subject_code.toUpperCase() : '',
  }));

  return { classes, subjects, assignments };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/rosterBulkImportParser.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/rosterBulkImportParser.ts apps/api/src/__tests__/rosterBulkImportParser.test.ts
git commit -m "feat: add Roster bulk-import file parser for the 3-sheet workbook"
```

---

### Task 2: Batched lookup queries + validation (`rosterBulkImportValidation.ts`)

**Files:**
- Modify: `apps/api/src/db/queries/roster.ts` (add 3 new exports at the end)
- Create: `apps/api/src/services/rosterBulkImportValidation.ts`
- Test: `apps/api/src/__tests__/rosterQueries.test.ts` (new file, for the 3 new query functions)
- Test: `apps/api/src/__tests__/rosterBulkImportValidation.test.ts` (new file)

**Interfaces:**
- Consumes: `ParsedClassRow`, `ParsedSubjectRow`, `ParsedAssignmentRow` from Task 1.
- Produces (from `db/queries/roster.ts`): `findTeachersByEmails(schoolId: string, emails: string[]): Promise<Map<string, { id: string }>>`, `listClassNamesAndIds(schoolId: string): Promise<{ id: string; name: string }[]>`, `listSubjectCodesAndIds(schoolId: string): Promise<{ id: string; code: string }[]>` — consumed by Task 3 (preview) and Task 4 (commit).
- Produces (from `rosterBulkImportValidation.ts`): `ClassValidationResult`, `SubjectValidationResult`, `AssignmentValidationResult`, `RosterValidationDeps`, `runFullRosterValidation(parsed: ParsedRosterWorkbook, deps: RosterValidationDeps): Promise<{ classes: ClassValidationResult[]; subjects: SubjectValidationResult[]; assignments: AssignmentValidationResult[] }>` — consumed by Task 3 and Task 4.

- [ ] **Step 1: Write the failing tests for the new queries**

Create `apps/api/src/__tests__/rosterQueries.test.ts`:

```ts
import pool from '../db/client';
import { findTeachersByEmails, listClassNamesAndIds, listSubjectCodesAndIds } from '../db/queries/roster';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('findTeachersByEmails', () => {
  it('returns an empty map without querying when given no emails', async () => {
    const result = await findTeachersByEmails('school-1', []);
    expect(result).toEqual(new Map());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns a lowercase-email-to-id map, scoped to teacher role', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'teacher-1', email: 'Chidi@Example.com' }],
    });

    const result = await findTeachersByEmails('school-1', ['chidi@example.com']);

    expect(result.get('chidi@example.com')).toEqual({ id: 'teacher-1' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("role = 'teacher'"),
      ['school-1', ['chidi@example.com']]
    );
  });
});

describe('listClassNamesAndIds', () => {
  it('returns all classes for the school as id/name pairs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'class-1', name: 'JSS 1A' }] });
    const result = await listClassNamesAndIds('school-1');
    expect(result).toEqual([{ id: 'class-1', name: 'JSS 1A' }]);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['school-1']);
  });
});

describe('listSubjectCodesAndIds', () => {
  it('returns all subjects for the school as id/code pairs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'subject-1', code: 'MTH' }] });
    const result = await listSubjectCodesAndIds('school-1');
    expect(result).toEqual([{ id: 'subject-1', code: 'MTH' }]);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['school-1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/__tests__/rosterQueries.test.ts`
Expected: FAIL — the three functions don't exist yet

- [ ] **Step 3: Add the three query functions to `apps/api/src/db/queries/roster.ts`**

Append to the end of the file:

```ts
// ── Bulk import support ──────────────────────────────────────────────────────

/** Maps each matched email (lowercased) to the id of the teacher-role user it
 *  belongs to, for the subset of the given emails that resolve to an actual
 *  teacher in this school. Platform-wide findUsersRolesByEmails (used by the
 *  Students bulk import) isn't reused here — Roster needs the id to store as
 *  form_teacher_id/teacher_id, scoped to this school's teachers specifically. */
export async function findTeachersByEmails(schoolId: string, emails: string[]): Promise<Map<string, { id: string }>> {
  if (emails.length === 0) return new Map();
  const result = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE school_id = $1 AND role = 'teacher' AND LOWER(email) = ANY($2::text[])`,
    [schoolId, emails.map(e => e.toLowerCase())]
  );
  return new Map(result.rows.map(r => [r.email.toLowerCase(), { id: r.id }]));
}

/** Lean id/name pairs for every class in the school — used by bulk-import
 *  validation for duplicate detection and Teacher Assignment resolution,
 *  without the extra columns listClasses() returns. */
export async function listClassNamesAndIds(schoolId: string): Promise<{ id: string; name: string }[]> {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM classes WHERE school_id = $1`,
    [schoolId]
  );
  return result.rows;
}

/** Lean id/code pairs for every subject in the school (not filtered to
 *  is_active, matching findSubjectByCode's own unfiltered duplicate check) —
 *  used by bulk-import validation for duplicate detection and Teacher
 *  Assignment resolution. */
export async function listSubjectCodesAndIds(schoolId: string): Promise<{ id: string; code: string }[]> {
  const result = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM subjects WHERE school_id = $1`,
    [schoolId]
  );
  return result.rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/__tests__/rosterQueries.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing tests for validation**

Create `apps/api/src/__tests__/rosterBulkImportValidation.test.ts`:

```ts
import { runFullRosterValidation, type RosterValidationDeps } from '../services/rosterBulkImportValidation';
import type { ParsedClassRow, ParsedSubjectRow, ParsedAssignmentRow } from '../services/rosterBulkImportParser';

function classRow(overrides: Partial<ParsedClassRow> = {}): ParsedClassRow {
  return { row_number: 2, name: 'JSS 1A', level: 'JSS1', stream: null, form_teacher_email: null, ...overrides };
}
function subjectRow(overrides: Partial<ParsedSubjectRow> = {}): ParsedSubjectRow {
  return { row_number: 2, name: 'Mathematics', code: 'MTH', ...overrides };
}
function assignmentRow(overrides: Partial<ParsedAssignmentRow> = {}): ParsedAssignmentRow {
  return { row_number: 2, teacher_email: 'teacher@example.com', class_name: 'JSS 1A', subject_code: 'MTH', ...overrides };
}

function baseDeps(overrides: Partial<RosterValidationDeps> = {}): RosterValidationDeps {
  return {
    existingClasses: [],
    existingSubjects: [],
    lookupTeachersByEmails: async () => new Map(),
    activeTerm: { id: 'term-1' },
    findDuplicateAssignment: async () => false,
    ...overrides,
  };
}

describe('runFullRosterValidation — classes', () => {
  it('marks a minimal valid class row as valid', async () => {
    const result = await runFullRosterValidation({ classes: [classRow()], subjects: [], assignments: [] }, baseDeps());
    expect(result.classes[0].status).toBe('valid');
  });

  it('flags a missing name or level', async () => {
    const result = await runFullRosterValidation({ classes: [classRow({ name: '' })], subjects: [], assignments: [] }, baseDeps());
    expect(result.classes[0].status).toBe('error');
    expect(result.classes[0].errors).toContain('Name is required.');
  });

  it('flags a class name that already exists in the school', async () => {
    const deps = baseDeps({ existingClasses: [{ id: 'c1', name: 'JSS 1A' }] });
    const result = await runFullRosterValidation({ classes: [classRow()], subjects: [], assignments: [] }, deps);
    expect(result.classes[0].status).toBe('error');
    expect(result.classes[0].errors[0]).toContain('already exists');
  });

  it('flags a class name duplicated within the same file', async () => {
    const rows = [classRow({ row_number: 2 }), classRow({ row_number: 3 })];
    const result = await runFullRosterValidation({ classes: rows, subjects: [], assignments: [] }, baseDeps());
    expect(result.classes[0].status).toBe('valid');
    expect(result.classes[1].status).toBe('error');
    expect(result.classes[1].errors[0]).toContain('earlier row');
  });

  it('flags a form teacher email that does not resolve to a teacher', async () => {
    const result = await runFullRosterValidation(
      { classes: [classRow({ form_teacher_email: 'nobody@example.com' })], subjects: [], assignments: [] },
      baseDeps()
    );
    expect(result.classes[0].status).toBe('error');
    expect(result.classes[0].errors[0]).toContain('does not match an existing teacher');
  });

  it('accepts a form teacher email that resolves to a teacher', async () => {
    const deps = baseDeps({ lookupTeachersByEmails: async () => new Map([['chidi@example.com', { id: 't1' }]]) });
    const result = await runFullRosterValidation(
      { classes: [classRow({ form_teacher_email: 'chidi@example.com' })], subjects: [], assignments: [] },
      deps
    );
    expect(result.classes[0].status).toBe('valid');
  });
});

describe('runFullRosterValidation — subjects', () => {
  it('flags a subject code that already exists', async () => {
    const deps = baseDeps({ existingSubjects: [{ id: 's1', code: 'MTH' }] });
    const result = await runFullRosterValidation({ classes: [], subjects: [subjectRow()], assignments: [] }, deps);
    expect(result.subjects[0].status).toBe('error');
  });

  it('flags a subject code duplicated within the same file', async () => {
    const rows = [subjectRow({ row_number: 2 }), subjectRow({ row_number: 3 })];
    const result = await runFullRosterValidation({ classes: [], subjects: rows, assignments: [] }, baseDeps());
    expect(result.subjects[1].status).toBe('error');
  });
});

describe('runFullRosterValidation — teacher assignments', () => {
  function fullDeps(): RosterValidationDeps {
    return baseDeps({
      existingClasses: [{ id: 'c1', name: 'JSS 1A' }],
      existingSubjects: [{ id: 's1', code: 'MTH' }],
      lookupTeachersByEmails: async () => new Map([['teacher@example.com', { id: 't1' }]]),
    });
  }

  it('marks a fully-resolvable assignment as valid and resolves all three ids', async () => {
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: [assignmentRow()] }, fullDeps());
    expect(result.assignments[0].status).toBe('valid');
    expect(result.assignments[0]).toMatchObject({
      resolved_teacher_id: 't1',
      resolved_class_id: 'c1',
      resolved_subject_id: 's1',
    });
  });

  it('flags an unresolvable teacher/class/subject independently', async () => {
    const deps = fullDeps();
    const result = await runFullRosterValidation(
      { classes: [], subjects: [], assignments: [assignmentRow({ teacher_email: 'nobody@example.com', class_name: 'Nope', subject_code: 'ZZZ' })] },
      deps
    );
    expect(result.assignments[0].status).toBe('error');
    expect(result.assignments[0].errors).toHaveLength(3);
  });

  it('flags every assignment row when there is no active term', async () => {
    const deps = fullDeps();
    deps.activeTerm = null;
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: [assignmentRow()] }, deps);
    expect(result.assignments[0].status).toBe('error');
    expect(result.assignments[0].errors[0]).toContain('No active term');
  });

  it('flags a duplicate teacher/class/subject combination already in the DB', async () => {
    const deps = fullDeps();
    deps.findDuplicateAssignment = async () => true;
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: [assignmentRow()] }, deps);
    expect(result.assignments[0].status).toBe('error');
    expect(result.assignments[0].errors[0]).toContain('already assigned');
  });

  it('flags a duplicate teacher/class/subject combination within the same file', async () => {
    const deps = fullDeps();
    const rows = [assignmentRow({ row_number: 2 }), assignmentRow({ row_number: 3 })];
    const result = await runFullRosterValidation({ classes: [], subjects: [], assignments: rows }, deps);
    expect(result.assignments[0].status).toBe('valid');
    expect(result.assignments[1].status).toBe('error');
    expect(result.assignments[1].errors[0]).toContain('earlier row');
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/rosterBulkImportValidation.test.ts`
Expected: FAIL with "Cannot find module '../services/rosterBulkImportValidation'"

- [ ] **Step 7: Write the implementation**

Create `apps/api/src/services/rosterBulkImportValidation.ts`:

```ts
import type { ParsedClassRow, ParsedSubjectRow, ParsedAssignmentRow, ParsedRosterWorkbook } from './rosterBulkImportParser';

export interface ClassValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  class: ParsedClassRow;
  resolved_form_teacher_id: string | null;
}

export interface SubjectValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  subject: ParsedSubjectRow;
}

export interface AssignmentValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  assignment: ParsedAssignmentRow;
  resolved_teacher_id: string | null;
  resolved_class_id: string | null;
  resolved_subject_id: string | null;
}

/**
 * Everything runFullRosterValidation needs from the outside world, injected
 * so this module stays DB-free and unit-testable. existingClasses/
 * existingSubjects/activeTerm are plain values (a single snapshot fetched
 * once by the caller before any commit-time inserts happen) — Teacher
 * Assignment rows must never resolve against something created earlier in
 * the same commit, so this snapshot is never refreshed mid-validation.
 */
export interface RosterValidationDeps {
  existingClasses: { id: string; name: string }[];
  existingSubjects: { id: string; code: string }[];
  lookupTeachersByEmails: (emails: string[]) => Promise<Map<string, { id: string }>>;
  activeTerm: { id: string } | null;
  findDuplicateAssignment: (teacherId: string, classId: string, subjectId: string, termId: string) => Promise<boolean>;
}

function validateClassRow(row: ParsedClassRow): string[] {
  const errors: string[] = [];
  if (!row.name) errors.push('Name is required.');
  else if (row.name.length > 255) errors.push('Name must be 255 characters or fewer.');
  if (!row.level) errors.push('Level is required.');
  else if (row.level.length > 100) errors.push('Level must be 100 characters or fewer.');
  if (row.stream && row.stream.length > 100) errors.push('Stream must be 100 characters or fewer.');
  return errors;
}

function validateSubjectRow(row: ParsedSubjectRow): string[] {
  const errors: string[] = [];
  if (!row.name) errors.push('Name is required.');
  else if (row.name.length > 255) errors.push('Name must be 255 characters or fewer.');
  if (!row.code) errors.push('Code is required.');
  else if (row.code.length > 20) errors.push('Code must be 20 characters or fewer.');
  return errors;
}

function validateAssignmentRowShape(row: ParsedAssignmentRow): string[] {
  const errors: string[] = [];
  if (!row.teacher_email) errors.push('Teacher Email is required.');
  if (!row.class_name) errors.push('Class Name is required.');
  if (!row.subject_code) errors.push('Subject Code is required.');
  return errors;
}

export async function runFullRosterValidation(
  parsed: ParsedRosterWorkbook,
  deps: RosterValidationDeps
): Promise<{ classes: ClassValidationResult[]; subjects: SubjectValidationResult[]; assignments: AssignmentValidationResult[] }> {
  // Every email this validation pass needs — form teachers on Classes rows,
  // plus assignment teachers — resolved in one batched call.
  const teacherEmailsNeeded = new Set<string>();
  for (const row of parsed.classes) {
    if (row.form_teacher_email) teacherEmailsNeeded.add(row.form_teacher_email);
  }
  for (const row of parsed.assignments) {
    if (row.teacher_email) teacherEmailsNeeded.add(row.teacher_email);
  }
  const teacherMatches = await deps.lookupTeachersByEmails([...teacherEmailsNeeded]);

  // ── Classes ──────────────────────────────────────────────────────────────
  const existingClassNames = new Set(deps.existingClasses.map(c => c.name));
  const seenClassNames = new Set<string>();
  const classResults: ClassValidationResult[] = parsed.classes.map(row => {
    const errors = validateClassRow(row);
    if (row.name) {
      if (existingClassNames.has(row.name)) {
        errors.push(`A class named "${row.name}" already exists in this school.`);
      } else if (seenClassNames.has(row.name)) {
        errors.push('This class name also appears in an earlier row of this file.');
      } else {
        seenClassNames.add(row.name);
      }
    }
    let resolvedFormTeacherId: string | null = null;
    if (row.form_teacher_email) {
      const match = teacherMatches.get(row.form_teacher_email);
      if (!match) {
        errors.push(`Form Teacher Email "${row.form_teacher_email}" does not match an existing teacher in this school.`);
      } else {
        resolvedFormTeacherId = match.id;
      }
    }
    return { row_number: row.row_number, status: errors.length === 0 ? 'valid' as const : 'error' as const, errors, class: row, resolved_form_teacher_id: resolvedFormTeacherId };
  });

  // ── Subjects ─────────────────────────────────────────────────────────────
  const existingSubjectCodes = new Set(deps.existingSubjects.map(s => s.code));
  const seenSubjectCodes = new Set<string>();
  const subjectResults: SubjectValidationResult[] = parsed.subjects.map(row => {
    const errors = validateSubjectRow(row);
    if (row.code) {
      if (existingSubjectCodes.has(row.code)) {
        errors.push(`Subject code "${row.code}" already exists in this school.`);
      } else if (seenSubjectCodes.has(row.code)) {
        errors.push('This subject code also appears in an earlier row of this file.');
      } else {
        seenSubjectCodes.add(row.code);
      }
    }
    return { row_number: row.row_number, status: errors.length === 0 ? 'valid' as const : 'error' as const, errors, subject: row };
  });

  // ── Teacher Assignments ──────────────────────────────────────────────────
  const classByName = new Map(deps.existingClasses.map(c => [c.name, c.id]));
  const subjectByCode = new Map(deps.existingSubjects.map(s => [s.code, s.id]));
  const seenAssignmentKeys = new Set<string>();
  const assignmentResults: AssignmentValidationResult[] = [];

  for (const row of parsed.assignments) {
    const errors = validateAssignmentRowShape(row);
    let teacherId: string | null = null;
    let classId: string | null = null;
    let subjectId: string | null = null;

    if (row.teacher_email) {
      const match = teacherMatches.get(row.teacher_email);
      if (!match) {
        errors.push(`Teacher Email "${row.teacher_email}" does not match an existing teacher in this school.`);
      } else {
        teacherId = match.id;
      }
    }
    if (row.class_name) {
      const id = classByName.get(row.class_name);
      if (!id) {
        errors.push(`Class Name "${row.class_name}" does not match an existing class in this school.`);
      } else {
        classId = id;
      }
    }
    if (row.subject_code) {
      const id = subjectByCode.get(row.subject_code);
      if (!id) {
        errors.push(`Subject Code "${row.subject_code}" does not match an existing subject in this school.`);
      } else {
        subjectId = id;
      }
    }
    if (!deps.activeTerm) {
      errors.push('No active term found for this school. Activate a session and term first.');
    }

    if (teacherId && classId && subjectId) {
      const key = `${teacherId}|${classId}|${subjectId}`;
      if (seenAssignmentKeys.has(key)) {
        errors.push('This teacher/class/subject combination also appears in an earlier row of this file.');
      } else {
        seenAssignmentKeys.add(key);
        if (deps.activeTerm) {
          const isDuplicate = await deps.findDuplicateAssignment(teacherId, classId, subjectId, deps.activeTerm.id);
          if (isDuplicate) {
            errors.push('This teacher is already assigned to this class and subject for the current term.');
          }
        }
      }
    }

    assignmentResults.push({
      row_number: row.row_number,
      status: errors.length === 0 ? 'valid' : 'error',
      errors,
      assignment: row,
      resolved_teacher_id: teacherId,
      resolved_class_id: classId,
      resolved_subject_id: subjectId,
    });
  }

  return { classes: classResults, subjects: subjectResults, assignments: assignmentResults };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/rosterBulkImportValidation.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 9: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/db/queries/roster.ts apps/api/src/services/rosterBulkImportValidation.ts apps/api/src/__tests__/rosterQueries.test.ts apps/api/src/__tests__/rosterBulkImportValidation.test.ts
git commit -m "feat: add Roster bulk-import validation and batched lookup queries"
```

---

### Task 3: Preview endpoint

**Files:**
- Modify: `apps/api/src/routes/roster.ts`
- Test: `apps/api/tests/rosterBulkImport.test.ts` (new file — DB-integration style, matching `apps/api/tests/studentsBulkImport.test.ts` conventions)

**Interfaces:**
- Consumes: `parseRosterBulkImportFile`, `RosterBulkImportParseError` (Task 1); `runFullRosterValidation` (Task 2); `findTeachersByEmails`, `listClassNamesAndIds`, `listSubjectCodesAndIds`, `getActiveTerm`, `findDuplicateAssignment` (Task 2 + existing).
- Produces: `POST /:schoolId/roster-bulk-import/preview` — consumed by the frontend in Task 5.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/rosterBulkImport.test.ts`:

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
import rosterRouter from '../src/routes/roster';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
app.use('/api/schools', rosterRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function workbookBuffer(sheets: { name: string; headers: string[]; rows: (string | number)[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = workbook.addWorksheet(s.name);
    sheet.addRow(s.headers);
    s.rows.forEach(r => sheet.addRow(r));
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const CLASS_HEADERS = ['Name', 'Level', 'Stream', 'Form Teacher Email'];
const SUBJECT_HEADERS = ['Name', 'Code'];
const ASSIGNMENT_HEADERS = ['Teacher Email', 'Class Name', 'Subject Code'];

function fullWorkbook(overrides: Partial<Record<'Classes' | 'Subjects' | 'Teacher Assignments', (string | number)[][]>> = {}) {
  return workbookBuffer([
    { name: 'Classes', headers: CLASS_HEADERS, rows: overrides['Classes'] ?? [] },
    { name: 'Subjects', headers: SUBJECT_HEADERS, rows: overrides['Subjects'] ?? [] },
    { name: 'Teacher Assignments', headers: ASSIGNMENT_HEADERS, rows: overrides['Teacher Assignments'] ?? [] },
  ]);
}

describe('POST /:schoolId/roster-bulk-import/preview', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;
  let teacherEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Roster Bulk Preview Test School', `test-roster-preview-${randomUUID()}`]
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

    const teacherResult = await pool.query<{ email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    teacherEmail = teacherResult.rows[0].email;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM teacher_assignments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM classes WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM subjects WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    await pool.end();
  }, 30000);

  it('rejects a registrar with 403 (Roster stays principal/super_admin only, unlike Students)', async () => {
    const buffer = await fullWorkbook();
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'roster.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid Class row, a valid Subject row, and a valid Assignment row referencing an existing teacher', async () => {
    const buffer = await fullWorkbook({
      Classes: [['JSS 1A', 'JSS1', '', '']],
      Subjects: [['Mathematics', 'MTH']],
      'Teacher Assignments': [[teacherEmail, 'Some Existing Class', 'ENG']],
    });

    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'roster.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.classes.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(res.body.data.subjects.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    // The assignment row references a class/subject that don't exist yet (this preview
    // call doesn't create them) — correctly reported as an error, proving Assignments
    // never resolve against same-file Classes/Subjects rows per the design decision.
    expect(res.body.data.assignments.summary).toEqual({ total: 1, valid: 0, invalid: 1 });
    expect(res.body.data.assignments.rows[0].errors.some((e: string) => e.includes('does not match an existing class'))).toBe(true);
  });

  it('rejects a file missing the Teacher Assignments sheet entirely', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(CLASS_HEADERS);
    workbook.addWorksheet('Subjects').addRow(SUBJECT_HEADERS);
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', Buffer.from(arrayBuffer), 'roster.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a .csv upload outright', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', Buffer.from('a,b,c'), 'roster.csv');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a workbook with more than 300 rows total across all sheets', async () => {
    const manyClasses = Array.from({ length: 301 }, (_, i) => [`Class ${i}`, 'JSS1', '', '']);
    const buffer = await fullWorkbook({ Classes: manyClasses });
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'roster.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/rosterBulkImport.test.ts`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 3: Add imports to `apps/api/src/routes/roster.ts`**

At the top of the file, extend the existing imports:

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { verifyToken, requireRole } from '../middleware/auth';
import {
  findClassByName, insertClass, updateClass, listClasses,
  findClassById, classHasReferences, deleteClass,
  findSubjectByCode, insertSubject, updateSubject, listActiveSubjects,
  findSubjectById, subjectHasReferences, deleteSubject,
  getActiveTerm,
  findDuplicateAssignment, insertTeacherAssignment, listTeacherAssignments,
  findAssignmentById, scoresExistForAssignment, deleteTeacherAssignment,
  findTeachersByEmails, listClassNamesAndIds, listSubjectCodesAndIds,
} from '../db/queries/roster';
import { findUserById } from '../db/queries/users';
import { cache } from '../services/cacheService';
import { parseRosterBulkImportFile, RosterBulkImportParseError } from '../services/rosterBulkImportParser';
import { runFullRosterValidation } from '../services/rosterBulkImportValidation';
```

(Note `multer` is a new import for this file — the single-item Roster routes never needed file upload before.)

- [ ] **Step 4: Add the preview route**

Insert immediately before `export default router;` at the end of `apps/api/src/routes/roster.ts`:

```ts
// ── POST /:schoolId/roster-bulk-import/preview ──────────────────────────────
// Parses and validates a 3-sheet workbook without writing anything — the
// principal confirms via /roster-bulk-import/commit afterward. See
// docs/superpowers/specs/2026-08-20-roster-bulk-import-design.md for the
// full design rationale, including why Teacher Assignment rows never
// resolve against same-file Classes/Subjects rows.

const MAX_ROSTER_BULK_IMPORT_ROWS = 300;
const rosterBulkImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post(
  '/:schoolId/roster-bulk-import/preview',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  rosterBulkImportUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

      let parsed;
      try {
        parsed = await parseRosterBulkImportFile(file.buffer, file.originalname);
      } catch (err) {
        if (err instanceof RosterBulkImportParseError) {
          return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: err.message } });
        }
        return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: 'This file could not be read. Please check it is a valid .xlsx file.' } });
      }

      const totalRows = parsed.classes.length + parsed.subjects.length + parsed.assignments.length;
      if (totalRows === 0) {
        return res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'No rows were found in any sheet of this file.' } });
      }
      if (totalRows > MAX_ROSTER_BULK_IMPORT_ROWS) {
        return res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_ROWS', message: `This file has ${totalRows} rows across all sheets — the maximum per import is ${MAX_ROSTER_BULK_IMPORT_ROWS}. Split it into multiple files.` },
        });
      }

      const [existingClasses, existingSubjects, activeTerm] = await Promise.all([
        listClassNamesAndIds(req.params.schoolId),
        listSubjectCodesAndIds(req.params.schoolId),
        getActiveTerm(req.params.schoolId),
      ]);

      const results = await runFullRosterValidation(parsed, {
        existingClasses,
        existingSubjects,
        activeTerm,
        lookupTeachersByEmails: (emails) => findTeachersByEmails(req.params.schoolId, emails),
        findDuplicateAssignment: (teacherId, classId, subjectId, termId) => findDuplicateAssignment(teacherId, classId, subjectId, termId),
      });

      function summarize(rows: { status: 'valid' | 'error' }[]) {
        return { total: rows.length, valid: rows.filter(r => r.status === 'valid').length, invalid: rows.filter(r => r.status === 'error').length };
      }

      return res.json({
        success: true,
        data: {
          classes: { rows: results.classes, summary: summarize(results.classes) },
          subjects: { rows: results.subjects, summary: summarize(results.subjects) },
          assignments: { rows: results.assignments, summary: summarize(results.assignments) },
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest tests/rosterBulkImport.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/roster.ts apps/api/tests/rosterBulkImport.test.ts
git commit -m "feat: add Roster bulk-import preview endpoint"
```

---

### Task 4: Results file generator + commit endpoint

**Files:**
- Create: `apps/api/src/services/rosterBulkImportResults.ts`
- Modify: `apps/api/src/routes/roster.ts`
- Modify: `apps/api/tests/rosterBulkImport.test.ts` (add a new `describe` block)

**Interfaces:**
- Produces (from `rosterBulkImportResults.ts`): `generateRosterBulkImportResultsFile(classes: CreatedClassRecord[], subjects: CreatedSubjectRecord[], assignments: CreatedAssignmentRecord[]): Promise<Buffer>`.
- Produces (from the route): `POST /:schoolId/roster-bulk-import/commit` — consumed by the frontend in Task 5.
- Consumes: `insertClass`, `insertSubject`, `insertTeacherAssignment`, `cache.del` (all already imported/defined in `roster.ts`), `runFullRosterValidation` (Task 2).

- [ ] **Step 1: Write the failing unit test for the results file generator**

Create `apps/api/src/__tests__/rosterBulkImportResults.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { generateRosterBulkImportResultsFile } from '../services/rosterBulkImportResults';

describe('generateRosterBulkImportResultsFile', () => {
  it('produces a workbook with Summary, Classes Created, Subjects Created, and Assignments Created sheets', async () => {
    const buffer = await generateRosterBulkImportResultsFile(
      [{ row_number: 2, name: 'JSS 1A', level: 'JSS1' }],
      [{ row_number: 2, name: 'Mathematics', code: 'MTH' }],
      [{ row_number: 2, teacher_email: 'teacher@example.com', class_name: 'JSS 1A', subject_code: 'MTH' }]
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Classes Created', 'Subjects Created', 'Assignments Created']);
    expect(workbook.getWorksheet('Classes Created')!.getRow(2).getCell(2).value).toBe('JSS 1A');
    expect(workbook.getWorksheet('Subjects Created')!.getRow(2).getCell(3).value).toBe('MTH');
    expect(workbook.getWorksheet('Assignments Created')!.getRow(2).getCell(2).value).toBe('teacher@example.com');
  });

  it('handles all-empty inputs without error', async () => {
    const buffer = await generateRosterBulkImportResultsFile([], [], []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/__tests__/rosterBulkImportResults.test.ts`
Expected: FAIL with "Cannot find module '../services/rosterBulkImportResults'"

- [ ] **Step 3: Write the results file generator**

Create `apps/api/src/services/rosterBulkImportResults.ts`:

```ts
import ExcelJS from 'exceljs';

export interface CreatedClassRecord {
  row_number: number;
  name: string;
  level: string;
}

export interface CreatedSubjectRecord {
  row_number: number;
  name: string;
  code: string;
}

export interface CreatedAssignmentRecord {
  row_number: number;
  teacher_email: string;
  class_name: string;
  subject_code: string;
}

export async function generateRosterBulkImportResultsFile(
  classes: CreatedClassRecord[],
  subjects: CreatedSubjectRecord[],
  assignments: CreatedAssignmentRecord[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Roster Bulk Import Results']);
  summary.addRow([`${classes.length} class(es), ${subjects.length} subject(s), and ${assignments.length} teacher assignment(s) created.`]);

  const classesSheet = workbook.addWorksheet('Classes Created');
  classesSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Level', key: 'level', width: 16 },
  ];
  classes.forEach(c => classesSheet.addRow(c));

  const subjectsSheet = workbook.addWorksheet('Subjects Created');
  subjectsSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Code', key: 'code', width: 12 },
  ];
  subjects.forEach(s => subjectsSheet.addRow(s));

  const assignmentsSheet = workbook.addWorksheet('Assignments Created');
  assignmentsSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Teacher Email', key: 'teacher_email', width: 28 },
    { header: 'Class Name', key: 'class_name', width: 20 },
    { header: 'Subject Code', key: 'subject_code', width: 14 },
  ];
  assignments.forEach(a => assignmentsSheet.addRow(a));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/__tests__/rosterBulkImportResults.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing integration test for the commit endpoint**

Add to `apps/api/tests/rosterBulkImport.test.ts`, in a new `describe` block below the existing one (reusing the `app`, `makeToken`, `workbookBuffer`, `fullWorkbook`, `CLASS_HEADERS`, `SUBJECT_HEADERS`, `ASSIGNMENT_HEADERS` helpers already defined in that file — do not redeclare):

```ts
describe('POST /:schoolId/roster-bulk-import/commit', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;
  let teacherEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Roster Bulk Commit Test School', `test-roster-commit-${randomUUID()}`]
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

    const teacherResult = await pool.query<{ email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING email`,
      [schoolId, `teacher-commit-${randomUUID()}@test.com`]
    );
    teacherEmail = teacherResult.rows[0].email;

    // An active session + term is required for any Teacher Assignment to
    // validate — set one up directly, matching how other integration tests
    // in this repo establish active-term state.
    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, is_current) VALUES ($1, '2026/2027', true) RETURNING id`,
      [schoolId]
    );
    await pool.query(
      `INSERT INTO terms (school_id, session_id, name, is_current) VALUES ($1, $2, 'First Term', true)`,
      [schoolId, sessionResult.rows[0].id]
    );
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM teacher_assignments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM classes WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM subjects WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'roster.xlsx');
    return res.body.data;
  }

  it('rejects a registrar with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ classes: [], subjects: [], assignments: [] });
    expect(res.status).toBe(403);
  });

  it('creates a class and a subject, then a later import creates an assignment referencing them', async () => {
    const className = `JSS 1A ${randomUUID()}`;
    const subjectCode = `MTH${randomUUID().slice(0, 4).toUpperCase()}`;

    // Pass 1: Classes + Subjects only, matching the two-pass workflow the
    // design spec explicitly chose (Assignments never see same-commit rows).
    const buffer1 = await fullWorkbook({
      Classes: [[className, 'JSS1', '', '']],
      Subjects: [['Mathematics', subjectCode]],
    });
    const data1 = await preview(buffer1);
    const commit1 = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ classes: data1.classes.rows, subjects: data1.subjects.rows, assignments: [] });

    expect(commit1.status).toBe(200);
    expect(commit1.body.data.classes.created).toBe(1);
    expect(commit1.body.data.subjects.created).toBe(1);
    expect(typeof commit1.body.data.download_base64).toBe('string');

    const classRow = await pool.query(`SELECT id FROM classes WHERE school_id = $1 AND name = $2`, [schoolId, className]);
    expect(classRow.rows).toHaveLength(1);

    // Pass 2: now that the class/subject exist, an Assignment referencing
    // them resolves and commits successfully.
    const buffer2 = await fullWorkbook({
      'Teacher Assignments': [[teacherEmail, className, subjectCode]],
    });
    const data2 = await preview(buffer2);
    expect(data2.assignments.summary).toEqual({ total: 1, valid: 1, invalid: 0 });

    const commit2 = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ classes: [], subjects: [], assignments: data2.assignments.rows });

    expect(commit2.status).toBe(200);
    expect(commit2.body.data.assignments.created).toBe(1);

    const assignmentRow = await pool.query(`SELECT id FROM teacher_assignments WHERE school_id = $1`, [schoolId]);
    expect(assignmentRow.rows).toHaveLength(1);
  });

  it('does not roll back other rows when one class row fails at commit time', async () => {
    const goodName = `Good Class ${randomUUID()}`;
    const conflictName = `Conflict Class ${randomUUID()}`;

    const buffer = await fullWorkbook({ Classes: [[goodName, 'JSS1', '', ''], [conflictName, 'JSS1', '', '']] });
    const data = await preview(buffer);

    // Simulate a race: another request creates conflictName between preview and commit.
    await pool.query(
      `INSERT INTO classes (school_id, name, level) VALUES ($1, $2, 'JSS1')`,
      [schoolId, conflictName]
    );

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ classes: data.classes.rows, subjects: [], assignments: [] });

    expect(commit.status).toBe(200);
    expect(commit.body.data.classes.created).toBe(1);
    expect(commit.body.data.classes.failed).toBe(1);

    const goodRow = await pool.query(`SELECT id FROM classes WHERE school_id = $1 AND name = $2`, [schoolId, goodName]);
    expect(goodRow.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/rosterBulkImport.test.ts -t "commit"`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 7: Add imports and the commit route to `apps/api/src/routes/roster.ts`**

Extend the imports at the top of the file:

```ts
import { generateRosterBulkImportResultsFile, type CreatedClassRecord, type CreatedSubjectRecord, type CreatedAssignmentRecord } from '../services/rosterBulkImportResults';
```

Insert immediately after the preview route added in Task 3, before `export default router;`:

```ts
// ── POST /:schoolId/roster-bulk-import/commit ───────────────────────────────
// Fetches ONE fresh snapshot of existing classes/subjects/active-term before
// any inserts happen, and validates every sheet against that single
// snapshot — this is what guarantees a Teacher Assignment row never
// resolves against a class/subject this same commit just created, per the
// design decision. Commits in order: Classes, then Subjects, then
// Assignments, one insert per row, wrapped in its own try/catch.

const rosterBulkImportRowSchema = z.object({
  row_number: z.number(),
  status: z.enum(['valid', 'error']),
  errors: z.array(z.string()),
});

const rosterBulkImportCommitSchema = z.object({
  classes: z.array(rosterBulkImportRowSchema.extend({
    class: z.object({
      row_number: z.number(),
      name: z.string(),
      level: z.string(),
      stream: z.string().nullable(),
      form_teacher_email: z.string().nullable(),
    }),
    resolved_form_teacher_id: z.string().nullable(),
  })).max(MAX_ROSTER_BULK_IMPORT_ROWS),
  subjects: z.array(rosterBulkImportRowSchema.extend({
    subject: z.object({
      row_number: z.number(),
      name: z.string(),
      code: z.string(),
    }),
  })).max(MAX_ROSTER_BULK_IMPORT_ROWS),
  assignments: z.array(rosterBulkImportRowSchema.extend({
    assignment: z.object({
      row_number: z.number(),
      teacher_email: z.string(),
      class_name: z.string(),
      subject_code: z.string(),
    }),
    resolved_teacher_id: z.string().nullable(),
    resolved_class_id: z.string().nullable(),
    resolved_subject_id: z.string().nullable(),
  })).max(MAX_ROSTER_BULK_IMPORT_ROWS),
});

router.post(
  '/:schoolId/roster-bulk-import/commit',
  verifyToken,
  requireSchoolAccess,
  requireRole('super_admin', 'principal'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = rosterBulkImportCommitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }

      const submittedClasses = parsed.data.classes.map(r => r.class);
      const submittedSubjects = parsed.data.subjects.map(r => r.subject);
      const submittedAssignments = parsed.data.assignments.map(r => r.assignment);

      // One snapshot, fetched once, before any insert in this request.
      const [existingClasses, existingSubjects, activeTerm] = await Promise.all([
        listClassNamesAndIds(req.params.schoolId),
        listSubjectCodesAndIds(req.params.schoolId),
        getActiveTerm(req.params.schoolId),
      ]);

      const revalidated = await runFullRosterValidation(
        { classes: submittedClasses, subjects: submittedSubjects, assignments: submittedAssignments },
        {
          existingClasses,
          existingSubjects,
          activeTerm,
          lookupTeachersByEmails: (emails) => findTeachersByEmails(req.params.schoolId, emails),
          findDuplicateAssignment: (teacherId, classId, subjectId, termId) => findDuplicateAssignment(teacherId, classId, subjectId, termId),
        }
      );

      // ── Classes ──
      const classResults: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdClasses: CreatedClassRecord[] = [];
      for (const row of revalidated.classes) {
        if (row.status === 'error') {
          classResults.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') });
          continue;
        }
        try {
          await insertClass(req.params.schoolId, row.class.name, row.class.level, row.class.stream, row.resolved_form_teacher_id);
          classResults.push({ row_number: row.row_number, status: 'created' });
          createdClasses.push({ row_number: row.row_number, name: row.class.name, level: row.class.level });
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'A class with this name already exists.'
            : 'Failed to create this class.';
          classResults.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }
      if (createdClasses.length > 0) cache.del(`roster:${req.params.schoolId}:classes`);

      // ── Subjects ──
      const subjectResults: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdSubjects: CreatedSubjectRecord[] = [];
      for (const row of revalidated.subjects) {
        if (row.status === 'error') {
          subjectResults.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') });
          continue;
        }
        try {
          await insertSubject(req.params.schoolId, row.subject.name, row.subject.code);
          subjectResults.push({ row_number: row.row_number, status: 'created' });
          createdSubjects.push({ row_number: row.row_number, name: row.subject.name, code: row.subject.code });
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'A subject with this code already exists.'
            : 'Failed to create this subject.';
          subjectResults.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }
      if (createdSubjects.length > 0) cache.del(`roster:${req.params.schoolId}:subjects`);

      // ── Teacher Assignments ──
      const assignmentResults: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdAssignments: CreatedAssignmentRecord[] = [];
      const teachersToInvalidate = new Set<string>();
      for (const row of revalidated.assignments) {
        if (row.status === 'error' || !row.resolved_teacher_id || !row.resolved_class_id || !row.resolved_subject_id || !activeTerm) {
          assignmentResults.push({ row_number: row.row_number, status: 'failed', reason: row.errors.join(' ') || 'Could not be created.' });
          continue;
        }
        try {
          await insertTeacherAssignment(row.resolved_teacher_id, row.resolved_class_id, row.resolved_subject_id, activeTerm.id, req.params.schoolId);
          assignmentResults.push({ row_number: row.row_number, status: 'created' });
          createdAssignments.push({
            row_number: row.row_number,
            teacher_email: row.assignment.teacher_email,
            class_name: row.assignment.class_name,
            subject_code: row.assignment.subject_code,
          });
          teachersToInvalidate.add(row.resolved_teacher_id);
        } catch (err: unknown) {
          const reason = err instanceof Error && 'code' in err && (err as { code?: string }).code === '23505'
            ? 'This assignment already exists.'
            : 'Failed to create this assignment.';
          assignmentResults.push({ row_number: row.row_number, status: 'failed', reason });
        }
      }
      teachersToInvalidate.forEach(teacherId => cache.del(`roster:${req.params.schoolId}:assignments:${teacherId}`));

      const resultsFile = await generateRosterBulkImportResultsFile(createdClasses, createdSubjects, createdAssignments);

      return res.json({
        success: true,
        data: {
          classes: { created: createdClasses.length, failed: classResults.filter(r => r.status === 'failed').length, results: classResults },
          subjects: { created: createdSubjects.length, failed: subjectResults.filter(r => r.status === 'failed').length, results: subjectResults },
          assignments: { created: createdAssignments.length, failed: assignmentResults.filter(r => r.status === 'failed').length, results: assignmentResults },
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

Run: `cd apps/api && npx jest tests/rosterBulkImport.test.ts --runInBand`
Expected: PASS (all tests in the file — preview + commit describe blocks)

- [ ] **Step 9: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 10: Before committing, check for and clean up orphaned test data**

This project's shared test database has previously accumulated orphaned rows from interrupted test runs. Run this check and clean up if needed before your final test run:

```bash
cd apps/api && node -e "
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const schools = await pool.query(\"SELECT id FROM schools WHERE name LIKE 'Roster Bulk%'\");
  const ids = schools.rows.map(r => r.id);
  console.log('found:', ids.length);
  if (ids.length > 0) {
    await pool.query('DELETE FROM teacher_assignments WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM classes WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM subjects WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM terms WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM academic_sessions WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM users WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM schools WHERE id = ANY(\$1::uuid[])', [ids]);
  }
  console.log('cleanup done');
  await pool.end();
})().catch(e => { console.error(e); pool.end(); });
"
```

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/rosterBulkImportResults.ts apps/api/src/__tests__/rosterBulkImportResults.test.ts apps/api/src/routes/roster.ts apps/api/tests/rosterBulkImport.test.ts
git commit -m "feat: add Roster bulk-import commit endpoint and results file generator"
```

---

### Task 5: Frontend — template asset + the import page

**Files:**
- Create: `apps/web/public/templates/roster-bulk-import-template.xlsx` (generated once via a temporary script, then committed as a static asset)
- Create: `apps/web/app/(dashboard)/settings/roster/import/page.tsx`

**Interfaces:**
- Consumes: `POST /:schoolId/roster-bulk-import/preview` and `POST /:schoolId/roster-bulk-import/commit` (Tasks 3 and 4) via `apiUpload`/`apiFetch` (`apps/web/lib/api.ts`, existing).

- [ ] **Step 1: Generate the template file**

Create a temporary script at the repo root, `_gen-roster-template.js` (deleted in Step 3 — not part of the final commit):

```js
const ExcelJS = require('exceljs');

async function main() {
  const wb = new ExcelJS.Workbook();

  const classesSheet = wb.addWorksheet('Classes');
  classesSheet.columns = [
    { header: 'Name', key: 'name', width: 18 },
    { header: 'Level', key: 'level', width: 14 },
    { header: 'Stream', key: 'stream', width: 14 },
    { header: 'Form Teacher Email', key: 'form_teacher_email', width: 28 },
  ];
  classesSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  classesSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
  classesSheet.addRow({ name: 'EXAMPLE-DELETE-THIS-ROW', level: 'JSS1', stream: '', form_teacher_email: '' });

  const subjectsSheet = wb.addWorksheet('Subjects');
  subjectsSheet.columns = [
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Code', key: 'code', width: 12 },
  ];
  subjectsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  subjectsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
  subjectsSheet.addRow({ name: 'EXAMPLE-DELETE-THIS-ROW', code: 'DEL' });

  const assignmentsSheet = wb.addWorksheet('Teacher Assignments');
  assignmentsSheet.columns = [
    { header: 'Teacher Email', key: 'teacher_email', width: 28 },
    { header: 'Class Name', key: 'class_name', width: 20 },
    { header: 'Subject Code', key: 'subject_code', width: 14 },
  ];
  assignmentsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  assignmentsSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
  assignmentsSheet.addRow({ teacher_email: 'delete-this-example-row@example.com', class_name: 'EXAMPLE-DELETE-THIS-ROW', subject_code: 'DEL' });

  await wb.xlsx.writeFile(process.argv[2]);
  console.log('Template written to', process.argv[2]);
}

main();
```

Run (from repo root):

```bash
mkdir -p apps/web/public/templates
node _gen-roster-template.js apps/web/public/templates/roster-bulk-import-template.xlsx
```

Note the example rows are deliberately unmistakable placeholders (`EXAMPLE-DELETE-THIS-ROW`, code `DEL`), matching the exact convention established for the Students & Parents template — do not use realistic-looking example data.

- [ ] **Step 2: Verify the template manually**

Open `apps/web/public/templates/roster-bulk-import-template.xlsx` and confirm: 3 sheets named exactly `Classes`, `Subjects`, `Teacher Assignments`; correct headers on each; one obviously-placeholder example row per sheet.

- [ ] **Step 3: Delete the temporary script**

```bash
rm _gen-roster-template.js
```

- [ ] **Step 4: Write the import page**

Create `apps/web/app/(dashboard)/settings/roster/import/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SheetRowResult<TItem> {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  [key: string]: unknown;
  item?: TItem;
}

interface ClassRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  class: { name: string; level: string; stream: string | null; form_teacher_email: string | null };
  resolved_form_teacher_id: string | null;
}

interface SubjectRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  subject: { name: string; code: string };
}

interface AssignmentRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  assignment: { teacher_email: string; class_name: string; subject_code: string };
  resolved_teacher_id: string | null;
  resolved_class_id: string | null;
  resolved_subject_id: string | null;
}

interface PreviewResponse {
  classes: { rows: ClassRow[]; summary: { total: number; valid: number; invalid: number } };
  subjects: { rows: SubjectRow[]; summary: { total: number; valid: number; invalid: number } };
  assignments: { rows: AssignmentRow[]; summary: { total: number; valid: number; invalid: number } };
}

interface CommitSheetResult {
  created: number;
  failed: number;
  results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }>;
}

interface CommitResponse {
  classes: CommitSheetResult;
  subjects: CommitSheetResult;
  assignments: CommitSheetResult;
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

function SheetPreviewTable({ title, rows, renderLabel }: { title: string; rows: { row_number: number; status: 'valid' | 'error'; errors: string[] }[]; renderLabel: (row: any) => string }) {
  const validCount = rows.filter(r => r.status === 'valid').length;
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <span className="text-xs text-gray-500">{validCount} of {rows.length} valid</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 px-4 py-6 text-center">No rows in this sheet.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.row_number}>
                <td className="px-4 py-2 text-gray-500 w-16">{r.row_number}</td>
                <td className="px-4 py-2">{renderLabel(r)}</td>
                <td className="px-4 py-2 w-40">
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
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RosterBulkImportPage() {
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
        `/api/schools/${schoolId}/roster-bulk-import/preview`,
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
        `/api/schools/${schoolId}/roster-bulk-import/commit`,
        {
          method: 'POST',
          body: JSON.stringify({
            classes: preview.classes.rows.filter(r => r.status === 'valid'),
            subjects: preview.subjects.rows.filter(r => r.status === 'valid'),
            assignments: preview.assignments.rows.filter(r => r.status === 'valid'),
          }),
        }
      );
      setCommitResult(res.data);
      setStep('done');
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
    }
  }

  const totalValid = preview
    ? preview.classes.summary.valid + preview.subjects.summary.valid + preview.assignments.summary.valid
    : 0;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-6">
        <Link href="/settings/roster" className="text-sm text-[#2472B4] hover:underline">← Back to Roster</Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">Bulk Import Roster</h1>
        <p className="text-sm text-gray-500 mt-1">Upload a workbook with Classes, Subjects, and Teacher Assignments sheets — up to 300 rows total.</p>
      </div>

      {step === 'upload' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <a
            href="/templates/roster-bulk-import-template.xlsx"
            download
            className="inline-block text-sm font-medium text-[#2472B4] hover:underline"
          >
            Download the import template (.xlsx)
          </a>
          <p className="text-xs text-gray-500">
            Teacher Assignment rows must reference classes/subjects/teachers that already exist — if you&apos;re setting up a new school, import Classes and Subjects first, then do a second import for Teacher Assignments.
          </p>
          <form onSubmit={handleUpload} className="space-y-4">
            <input
              type="file"
              accept=".xlsx"
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
          <SheetPreviewTable
            title="Classes"
            rows={preview.classes.rows}
            renderLabel={(r: ClassRow) => `${r.class.name} (${r.class.level})`}
          />
          <SheetPreviewTable
            title="Subjects"
            rows={preview.subjects.rows}
            renderLabel={(r: SubjectRow) => `${r.subject.name} (${r.subject.code})`}
          />
          <SheetPreviewTable
            title="Teacher Assignments"
            rows={preview.assignments.rows}
            renderLabel={(r: AssignmentRow) => `${r.assignment.teacher_email} → ${r.assignment.class_name} / ${r.assignment.subject_code}`}
          />

          {commitError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{commitError}</div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleCommit}
              disabled={totalValid === 0 || committing}
              className="px-5 py-2 bg-[#FF761B] text-white text-sm font-medium rounded-lg hover:bg-[#e56812] disabled:opacity-50"
            >
              {committing ? 'Importing…' : `Import ${totalValid} valid row${totalValid === 1 ? '' : 's'}`}
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
          <p className="text-lg font-semibold text-gray-900">
            {commitResult.classes.created} class(es), {commitResult.subjects.created} subject(s), {commitResult.assignments.created} assignment(s) created
          </p>

          {(commitResult.classes.failed + commitResult.subjects.failed + commitResult.assignments.failed) > 0 && (
            <p className="text-sm text-red-600">
              {commitResult.classes.failed + commitResult.subjects.failed + commitResult.assignments.failed} row(s) failed — see the downloaded results file for details.
            </p>
          )}

          <button
            type="button"
            onClick={() => downloadBase64File(commitResult.download_base64, 'chronix-edu-roster-bulk-import-results.xlsx')}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
          >
            Download results (.xlsx)
          </button>

          <div>
            <Link href="/settings/roster" className="text-sm text-[#2472B4] hover:underline">← Back to Roster</Link>
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
git add apps/web/public/templates/roster-bulk-import-template.xlsx "apps/web/app/(dashboard)/settings/roster/import/page.tsx"
git commit -m "feat: add Roster bulk-import page and downloadable template"
```

---

### Task 6: Entry point on the Roster page + full manual verification

**Files:**
- Modify: `apps/web/app/(dashboard)/settings/roster/page.tsx`

**Interfaces:**
- Consumes: the page created in Task 5 (`/settings/roster/import`).

- [ ] **Step 1: Add the `Link` import and the "Bulk Import" link**

In `apps/web/app/(dashboard)/settings/roster/page.tsx`, add to the top of the existing import block:

```tsx
import Link from 'next/link';
```

Find this block (around line 806-807):

```tsx
      <h1 className="text-xl font-semibold text-gray-900 mb-1">Roster Management</h1>
      <p className="text-sm text-gray-500 mb-6">Manage classes, subjects, and teacher-to-class-and-subject assignments.</p>
```

Replace it with:

```tsx
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-1">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Roster Management</h1>
          <p className="text-sm text-gray-500 mt-1">Manage classes, subjects, and teacher-to-class-and-subject assignments.</p>
        </div>
        <Link
          href="/settings/roster/import"
          className="shrink-0 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
        >
          Bulk Import
        </Link>
      </div>
      <div className="mb-6" />
```

- [ ] **Step 2: Run typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Full backend test suite**

Run: `cd apps/api && npx jest --runInBand`
Expected: all suites pass (existing suites unaffected + all new Roster bulk-import tests from Tasks 1-4)

- [ ] **Step 4: Manual end-to-end verification**

Write a standalone verification script (same pattern used for the Students & Parents feature — a throwaway `ts-node` script at `apps/api/_e2e_verify_roster.ts`, deleted after running) that:
1. Loads the real downloadable template file (`apps/web/public/templates/roster-bulk-import-template.xlsx`) exactly as a principal would.
2. Runs it through preview — confirm the example rows in Classes and Subjects preview as `valid`, and the Teacher Assignments example row previews as `error` (since its referenced class/subject/teacher don't exist yet — this is the two-pass workflow working as designed, not a bug).
3. Commits the valid Classes + Subjects rows, confirms both were created in the DB.
4. Builds a second small in-memory workbook whose Teacher Assignments sheet references the class/subject just created (using a real teacher account created for the test) plus a valid Teacher Assignment, previews it, confirms it resolves as `valid` this time, commits it, and confirms the assignment row exists in `teacher_assignments`.
5. Confirms the results file from the second commit decodes as a valid `.xlsx` (starts with the `PK` zip signature).
6. Cleans up all test data created (school, users, session, term, classes, subjects, assignments) in FK-safe order, matching the established cleanup pattern from the Students & Parents verification script.

Run it, confirm every step passes, then delete the script (never committed).

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(dashboard)/settings/roster/page.tsx"
git commit -m "feat: add Bulk Import entry point to the Roster page"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the design spec maps to a task — file parsing for all 3 sheets (Task 1), batched lookups + validation across all 3 sheets including the pre-existing-data-only Assignment resolution rule (Task 2), the preview endpoint with the 300-row cap (Task 3), the commit endpoint's single-snapshot-before-any-inserts guarantee + results file + cache invalidation (Task 4), the 3-sheet frontend page + branded template (Task 5), and the entry point + full end-to-end verification proving the two-pass workflow (Task 6).
- **Type consistency checked:** `ParsedClassRow`/`ParsedSubjectRow`/`ParsedAssignmentRow` (Task 1) flow unchanged into `ClassValidationResult`/`SubjectValidationResult`/`AssignmentValidationResult` (Task 2), which flow unchanged into the preview response shape and the commit request Zod schema (Tasks 3-4) and the frontend's matching interfaces (Task 5) — field names match end to end.
- **No placeholders:** every step has real, complete code.
- **Naming correction applied before writing this plan:** the spec originally sketched `/:schoolId/roster/bulk-import/...` and `.xlsx/.csv` support — both were caught as inconsistent with the existing `roster.ts` router's actual path convention and with the "one file, three sheets" decision (CSV can't hold 3 sheets) respectively, and fixed in the spec itself before this plan was written from it.
