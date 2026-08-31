# Bulk Payment Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a bursar/super_admin upload a spreadsheet of historical/pre-implementation payments and record them in bulk against students' existing invoices for a chosen term — reusing the exact `recordPayment()` logic the live "Record Payment" endpoint already uses, not reimplementing invoice math.

**Architecture:** Two new endpoints on the existing `apps/api/src/routes/fees.ts` router — `POST /:schoolId/payments-bulk-import/preview` (parses + validates, writes nothing) and `POST /:schoolId/payments-bulk-import/commit` (re-validates from scratch, then calls `recordPayment()` once per valid row). A new frontend page at `apps/web/app/(dashboard)/bursar/fee-structures/import/page.tsx` drives the upload → preview → commit flow, adapted from the Staff bulk-import page's layout but with a term-selector step first (term is chosen once per import, not per row).

**Tech Stack:** Express + TypeScript + Zod + `pg`, `exceljs` (CSV+XLSX parsing, existing dependency), Next.js 14 App Router.

**Spec:** `docs/superpowers/specs/2026-08-31-bulk-payment-import-design.md`

## Global Constraints

- File formats: `.xlsx` and `.csv` both accepted (single flat table).
- Columns: `Admission Number*`, `Amount*`, `Method*` (cash/bank_transfer/waiver only — never paystack), `Payment Date` (optional, `YYYY-MM-DD`, defaults to commit time if blank), `Reference` (optional).
- Term is selected **once per import** (a `term_id` field alongside the file upload), not a per-row column.
- Role gate on both endpoints: `requireRole('bursar', 'super_admin')` — matches the existing single-item `POST /:schoolId/payments` route exactly. This differs from the other three bulk-import features (which are principal-gated) — payment recording has always been a bursar responsibility in this app.
- A row with no existing `fee_invoices` row for the student+chosen-term fails with a clear error — this feature never generates invoices.
- Amount must not exceed the invoice's outstanding balance. Because two rows in the same file can target the same student's invoice (e.g. two partial historical payments), both preview and commit validation track a **running remaining balance per student**, starting from the real DB balance and decrementing as each valid row for that student is processed in file order — this is what lets preview correctly flag a second same-student row that would overpay, not just the first.
- Every valid row's actual payment write goes through the **existing** `recordPayment()` function (`apps/api/src/db/queries/fees.ts`) — not a reimplementation. This task extends `recordPayment()`'s `PaymentInput` with an optional `payment_date`, backward-compatible (the live single-item endpoint doesn't pass one and is unaffected).
- Row cap: **100 rows**, starting value pending the real-world timing measurement in Task 6 (each row is one DB-only transaction, no external API calls — lighter than Staff bulk import's Supabase Auth calls, comparable to or lighter than Students' `registerStudent()`).
- Commit re-validates every row from scratch — never trusts the client-supplied row data or `status` field from preview.
- The results file (`.xlsx`) must include **both** created and failed rows with reasons, from the start — the Staff bulk-import feature's final review caught this as a late fix; this plan builds it in from Task 4 directly.
- Every successful payment gets an audit-log entry (`PAYMENT_RECORDED`, matching the single-item route), plus one summary-level `PAYMENT_BULK_IMPORT` audit entry for the whole commit.

---

### Task 1: File parser (`bulkPaymentImportParser.ts`)

**Files:**
- Create: `apps/api/src/services/bulkPaymentImportParser.ts`
- Test: `apps/api/src/__tests__/bulkPaymentImportParser.test.ts`

**Interfaces:**
- Produces: `ParsedPaymentRow`, `BulkPaymentImportParseError`, `parseBulkPaymentImportFile(buffer: Buffer, filename: string): Promise<ParsedPaymentRow[]>` — consumed by Task 2 (validation) and Task 3 (preview endpoint).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/bulkPaymentImportParser.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { parseBulkPaymentImportFile, BulkPaymentImportParseError } from '../services/bulkPaymentImportParser';

async function xlsxBuffer(headers: string[], rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Payments');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Admission Number', 'Amount', 'Method', 'Payment Date', 'Reference'];

describe('parseBulkPaymentImportFile', () => {
  it('parses a well-formed row from .xlsx', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['SCH/2024/0001', 50000, 'Cash', '2026-01-15', 'Receipt #221']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_number: 2,
      admission_no: 'SCH/2024/0001',
      amount: '50000',
      method: 'cash',
      payment_date: '2026-01-15',
      reference: 'Receipt #221',
    });
  });

  it('parses the same shape from .csv', async () => {
    const csv = 'Admission Number,Amount,Method,Payment Date,Reference\nSCH/2024/0002,30000,bank_transfer,,\n';
    const rows = await parseBulkPaymentImportFile(Buffer.from(csv), 'payments.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admission_no: 'SCH/2024/0002', amount: '30000', method: 'bank_transfer', payment_date: null, reference: null });
  });

  it('lowercases method, leaves admission_no and reference as-is', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['sch/2024/0003', 1000, 'WAIVER', '', '']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows[0].admission_no).toBe('sch/2024/0003');
    expect(rows[0].method).toBe('waiver');
  });

  it('assigns the real sheet row number and skips fully blank rows without compacting', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['SCH/2024/0001', 1000, 'cash', '', ''],
      ['', '', '', '', ''],
      ['SCH/2024/0002', 2000, 'cash', '', ''],
    ]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows.map(r => r.row_number)).toEqual([2, 4]);
  });

  it('does not drop a row that has content but is missing a required field', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['', 1000, 'cash', '', '']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admission_no: '', amount: '1000' });
  });

  it('throws BulkPaymentImportParseError when a required column is missing', async () => {
    const buffer = await xlsxBuffer(['Admission Number', 'Amount'], [['SCH/2024/0001', 1000]]); // missing Method
    await expect(parseBulkPaymentImportFile(buffer, 'payments.xlsx')).rejects.toThrow(BulkPaymentImportParseError);
  });

  it('matches headers case-insensitively', async () => {
    const buffer = await xlsxBuffer(['admission number', 'AMOUNT', 'method'], [['SCH/2024/0001', 1000, 'cash']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows[0]).toMatchObject({ admission_no: 'SCH/2024/0001', amount: '1000', method: 'cash' });
  });

  it('handles a numeric Amount cell (not just text)', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['SCH/2024/0001', 12345.5, 'cash', '', '']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows[0].amount).toBe('12345.5');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/bulkPaymentImportParser.test.ts`
Expected: FAIL with "Cannot find module '../services/bulkPaymentImportParser'"

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/bulkPaymentImportParser.ts`:

```ts
import ExcelJS from 'exceljs';
import { Readable } from 'stream';

export interface ParsedPaymentRow {
  row_number: number;
  admission_no: string;
  amount: string;
  method: string;
  payment_date: string | null;
  reference: string | null;
}

export class BulkPaymentImportParseError extends Error {}

const REQUIRED_HEADERS = ['admission number', 'amount', 'method'];

const COLUMN_MAP: Record<string, string> = {
  'admission number': 'admission_no',
  'amount': 'amount',
  'method': 'method',
  'payment date': 'payment_date',
  'reference': 'reference',
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
  if (!sheet) throw new BulkPaymentImportParseError('The file has no worksheet.');
  return sheet;
}

export async function parseBulkPaymentImportFile(buffer: Buffer, filename: string): Promise<ParsedPaymentRow[]> {
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
    throw new BulkPaymentImportParseError(`The file is missing required column(s): ${missing.map(h => COLUMN_MAP[h]).join(', ')}`);
  }

  const rows: ParsedPaymentRow[] = [];
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
      admission_no: raw.admission_no ?? '',
      amount: raw.amount ?? '',
      method: raw.method ? raw.method.toLowerCase() : '',
      payment_date: raw.payment_date ?? null,
      reference: raw.reference ?? null,
    });
  });

  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/bulkPaymentImportParser.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/bulkPaymentImportParser.ts apps/api/src/__tests__/bulkPaymentImportParser.test.ts
git commit -m "feat: add Bulk Payment Import file parser (.xlsx/.csv)"
```

---

### Task 2: Batched student lookup query + validation module (with running-balance tracking)

**Files:**
- Modify: `apps/api/src/db/queries/students.ts` (add one new export)
- Create: `apps/api/src/services/bulkPaymentImportValidation.ts`
- Test: `apps/api/src/__tests__/studentsAdmissionLookup.test.ts` (new file, for the new query function)
- Test: `apps/api/src/__tests__/bulkPaymentImportValidation.test.ts` (new file)

**Interfaces:**
- Consumes: `ParsedPaymentRow` (Task 1).
- Produces (from `db/queries/students.ts`): `findStudentsByAdmissionNumbers(schoolId: string, admissionNumbers: string[]): Promise<Map<string, { id: string; first_name: string; last_name: string }>>` — consumed by Task 3 and Task 4.
- Produces (from `bulkPaymentImportValidation.ts`): `PaymentValidationResult`, `PaymentValidationDeps`, `validatePaymentRowShape(row: ParsedPaymentRow): string[]`, `runFullPaymentValidation(rows: ParsedPaymentRow[], deps: PaymentValidationDeps): Promise<PaymentValidationResult[]>` — consumed by Task 3 and Task 4.

- [ ] **Step 1: Write the failing test for the new query**

Create `apps/api/src/__tests__/studentsAdmissionLookup.test.ts`:

```ts
import pool from '../db/client';
import { findStudentsByAdmissionNumbers } from '../db/queries/students';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('findStudentsByAdmissionNumbers', () => {
  it('returns an empty map without querying when given no admission numbers', async () => {
    const result = await findStudentsByAdmissionNumbers('school-1', []);
    expect(result).toEqual(new Map());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns an admission_no-to-student map, scoped to active students in the school', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ admission_no: 'SCH/2024/0001', id: 'student-1', first_name: 'Ada', last_name: 'Obi' }],
    });

    const result = await findStudentsByAdmissionNumbers('school-1', ['SCH/2024/0001']);

    expect(result.get('SCH/2024/0001')).toEqual({ id: 'student-1', first_name: 'Ada', last_name: 'Obi' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('u.is_active = TRUE'),
      ['school-1', ['SCH/2024/0001']]
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/__tests__/studentsAdmissionLookup.test.ts`
Expected: FAIL — `findStudentsByAdmissionNumbers` doesn't exist yet

- [ ] **Step 3: Add the query function to `apps/api/src/db/queries/students.ts`**

Append to the end of the file:

```ts
// ── Bulk payment import support ─────────────────────────────────────────────

/** Maps each matched Admission Number to the student's id and name, for the
 *  subset of the given admission numbers that resolve to an active student in
 *  this school. Exact-match, not case-normalized — admission numbers are
 *  school-assigned codes (e.g. "SCH/2024/0001"), not free-text names. */
export async function findStudentsByAdmissionNumbers(
  schoolId: string,
  admissionNumbers: string[]
): Promise<Map<string, { id: string; first_name: string; last_name: string }>> {
  if (admissionNumbers.length === 0) return new Map();
  const result = await pool.query<{ admission_no: string; id: string; first_name: string; last_name: string }>(
    `SELECT s.admission_no, s.id, u.first_name, u.last_name
     FROM students s
     JOIN users u ON u.id = s.user_id
     WHERE s.school_id = $1 AND u.is_active = TRUE AND s.admission_no = ANY($2::text[])`,
    [schoolId, admissionNumbers]
  );
  return new Map(result.rows.map(r => [r.admission_no, { id: r.id, first_name: r.first_name, last_name: r.last_name }]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/__tests__/studentsAdmissionLookup.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the failing tests for validation**

Create `apps/api/src/__tests__/bulkPaymentImportValidation.test.ts`:

```ts
import { runFullPaymentValidation, validatePaymentRowShape, type PaymentValidationDeps } from '../services/bulkPaymentImportValidation';
import type { ParsedPaymentRow } from '../services/bulkPaymentImportParser';

function row(overrides: Partial<ParsedPaymentRow> = {}): ParsedPaymentRow {
  return {
    row_number: 2,
    admission_no: 'SCH/2024/0001',
    amount: '1000',
    method: 'cash',
    payment_date: null,
    reference: null,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<PaymentValidationDeps> = {}): PaymentValidationDeps {
  return {
    lookupStudentsByAdmissionNumbers: async () => new Map([['SCH/2024/0001', { id: 'student-1', first_name: 'Ada', last_name: 'Obi' }]]),
    lookupInvoiceForStudent: async () => ({ id: 'invoice-1', balance: 5000 }),
    ...overrides,
  };
}

describe('validatePaymentRowShape', () => {
  it('accepts a minimal valid row', () => {
    expect(validatePaymentRowShape(row())).toEqual([]);
  });

  it('flags a missing admission number', () => {
    expect(validatePaymentRowShape(row({ admission_no: '' }))).toContain('Admission Number is required.');
  });

  it('flags a missing or non-numeric amount', () => {
    expect(validatePaymentRowShape(row({ amount: '' }))).toContain('Amount is required.');
    expect(validatePaymentRowShape(row({ amount: 'abc' }))).toContain('Amount must be a positive number.');
    expect(validatePaymentRowShape(row({ amount: '-50' }))).toContain('Amount must be a positive number.');
    expect(validatePaymentRowShape(row({ amount: '0' }))).toContain('Amount must be a positive number.');
  });

  it('flags a method outside cash/bank_transfer/waiver', () => {
    expect(validatePaymentRowShape(row({ method: 'paystack' }))).toContain('Method must be one of: cash, bank_transfer, waiver.');
    expect(validatePaymentRowShape(row({ method: 'card' }))).toContain('Method must be one of: cash, bank_transfer, waiver.');
  });

  it('flags an invalid Payment Date format', () => {
    expect(validatePaymentRowShape(row({ payment_date: '15/01/2026' }))).toContain('Payment Date "15/01/2026" must be in YYYY-MM-DD format.');
  });

  it('flags a Payment Date in the future', () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString().slice(0, 10);
    expect(validatePaymentRowShape(row({ payment_date: futureDate }))).toContain('Payment Date cannot be in the future.');
  });

  it('accepts a valid past Payment Date', () => {
    expect(validatePaymentRowShape(row({ payment_date: '2026-01-15' }))).toEqual([]);
  });
});

describe('runFullPaymentValidation', () => {
  it('marks a valid row as valid and resolves student/invoice/amount', async () => {
    const results = await runFullPaymentValidation([row()], baseDeps());
    expect(results[0].status).toBe('valid');
    expect(results[0]).toMatchObject({ resolved_student_id: 'student-1', resolved_invoice_id: 'invoice-1', resolved_amount: 1000 });
  });

  it('flags an admission number that does not match an active student', async () => {
    const deps = baseDeps({ lookupStudentsByAdmissionNumbers: async () => new Map() });
    const results = await runFullPaymentValidation([row()], deps);
    expect(results[0].status).toBe('error');
    expect(results[0].errors[0]).toContain('does not match an existing active student');
  });

  it('flags a student with no invoice for the chosen term', async () => {
    const deps = baseDeps({ lookupInvoiceForStudent: async () => null });
    const results = await runFullPaymentValidation([row()], deps);
    expect(results[0].status).toBe('error');
    expect(results[0].errors[0]).toContain('No invoice found');
  });

  it('flags an amount exceeding the invoice balance', async () => {
    const deps = baseDeps({ lookupInvoiceForStudent: async () => ({ id: 'invoice-1', balance: 500 }) });
    const results = await runFullPaymentValidation([row({ amount: '1000' })], deps);
    expect(results[0].status).toBe('error');
    expect(results[0].errors[0]).toContain('exceeds the outstanding balance');
  });

  it('tracks a running balance across two rows for the same student in the same file', async () => {
    const deps = baseDeps({ lookupInvoiceForStudent: async () => ({ id: 'invoice-1', balance: 1000 }) });
    const rows = [row({ row_number: 2, amount: '700' }), row({ row_number: 3, amount: '700' })];
    const results = await runFullPaymentValidation(rows, deps);
    expect(results[0].status).toBe('valid');
    expect(results[1].status).toBe('error');
    expect(results[1].errors[0]).toContain('exceeds the outstanding balance');
  });

  it('only looks up the invoice once per student even across multiple rows', async () => {
    const lookupInvoice = jest.fn().mockResolvedValue({ id: 'invoice-1', balance: 1000 });
    const deps = baseDeps({ lookupInvoiceForStudent: lookupInvoice });
    const rows = [row({ row_number: 2, amount: '300' }), row({ row_number: 3, amount: '300' })];
    await runFullPaymentValidation(rows, deps);
    expect(lookupInvoice).toHaveBeenCalledTimes(1);
  });

  it('does not call the student lookup when there are no rows', async () => {
    const lookup = jest.fn(async () => new Map());
    await runFullPaymentValidation([], baseDeps({ lookupStudentsByAdmissionNumbers: lookup }));
    expect(lookup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/__tests__/bulkPaymentImportValidation.test.ts`
Expected: FAIL with "Cannot find module '../services/bulkPaymentImportValidation'"

- [ ] **Step 7: Write the implementation**

Create `apps/api/src/services/bulkPaymentImportValidation.ts`:

```ts
import type { ParsedPaymentRow } from './bulkPaymentImportParser';

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'waiver'] as const;
export type BulkPaymentMethod = typeof PAYMENT_METHODS[number];

export interface PaymentValidationResult {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  payment: ParsedPaymentRow;
  resolved_student_id: string | null;
  resolved_invoice_id: string | null;
  resolved_amount: number | null;
}

/**
 * Everything runFullPaymentValidation needs from the outside world, injected
 * so this module stays DB-free and unit-testable. lookupInvoiceForStudent is
 * scoped to a single (schoolId, termId) pair by the caller (a closure over
 * the route's chosen term) — this module only ever asks for one student's
 * invoice at a time, on that student's first appearance in the file.
 */
export interface PaymentValidationDeps {
  lookupStudentsByAdmissionNumbers: (admissionNumbers: string[]) => Promise<Map<string, { id: string; first_name: string; last_name: string }>>;
  lookupInvoiceForStudent: (studentId: string) => Promise<{ id: string; balance: number } | null>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validatePaymentRowShape(row: ParsedPaymentRow): string[] {
  const errors: string[] = [];

  if (!row.admission_no) errors.push('Admission Number is required.');

  if (!row.amount) {
    errors.push('Amount is required.');
  } else {
    const n = Number(row.amount);
    if (!Number.isFinite(n) || n <= 0) errors.push('Amount must be a positive number.');
  }

  if (!row.method) {
    errors.push('Method is required.');
  } else if (!(PAYMENT_METHODS as readonly string[]).includes(row.method)) {
    errors.push(`Method must be one of: ${PAYMENT_METHODS.join(', ')}.`);
  }

  if (row.payment_date) {
    if (!DATE_PATTERN.test(row.payment_date)) {
      errors.push(`Payment Date "${row.payment_date}" must be in YYYY-MM-DD format.`);
    } else if (row.payment_date > new Date().toISOString().slice(0, 10)) {
      errors.push('Payment Date cannot be in the future.');
    }
  }

  return errors;
}

export async function runFullPaymentValidation(
  rows: ParsedPaymentRow[],
  deps: PaymentValidationDeps
): Promise<PaymentValidationResult[]> {
  const admissionNumbers = [...new Set(rows.map(r => r.admission_no).filter(Boolean))];
  const students = admissionNumbers.length > 0 ? await deps.lookupStudentsByAdmissionNumbers(admissionNumbers) : new Map();

  // Tracks, per student, the invoice id and the balance remaining after every
  // valid row for that student processed so far in file order — computed
  // once per student (their real DB balance) on first appearance, then
  // decremented as later rows for the same student are validated. This is
  // what lets a second same-student row correctly fail as an overpayment
  // without ever writing anything.
  const invoiceStateByStudentId = new Map<string, { invoiceId: string; remainingBalance: number }>();

  const results: PaymentValidationResult[] = [];

  for (const row of rows) {
    const errors = validatePaymentRowShape(row);

    let resolvedAmount: number | null = null;
    if (row.amount) {
      const n = Number(row.amount);
      if (Number.isFinite(n) && n > 0) resolvedAmount = n;
    }

    let studentId: string | null = null;
    let invoiceId: string | null = null;

    if (row.admission_no) {
      const student = students.get(row.admission_no);
      if (!student) {
        errors.push(`Admission Number "${row.admission_no}" does not match an existing active student in this school.`);
      } else {
        studentId = student.id;

        if (!invoiceStateByStudentId.has(studentId)) {
          const invoice = await deps.lookupInvoiceForStudent(studentId);
          if (!invoice) {
            errors.push('No invoice found for this student for this term. Generate invoices for their class/term first.');
          } else {
            invoiceStateByStudentId.set(studentId, { invoiceId: invoice.id, remainingBalance: invoice.balance });
          }
        }

        const state = invoiceStateByStudentId.get(studentId);
        if (state) {
          invoiceId = state.invoiceId;
          if (resolvedAmount !== null) {
            if (resolvedAmount > state.remainingBalance) {
              errors.push(`Amount exceeds the outstanding balance (₦${state.remainingBalance.toFixed(2)} remaining as of this row).`);
            } else {
              state.remainingBalance -= resolvedAmount;
            }
          }
        }
      }
    }

    results.push({
      row_number: row.row_number,
      status: errors.length === 0 ? 'valid' : 'error',
      errors,
      payment: row,
      resolved_student_id: studentId,
      resolved_invoice_id: invoiceId,
      resolved_amount: resolvedAmount,
    });
  }

  return results;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/__tests__/bulkPaymentImportValidation.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 9: Run typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/db/queries/students.ts apps/api/src/services/bulkPaymentImportValidation.ts apps/api/src/__tests__/studentsAdmissionLookup.test.ts apps/api/src/__tests__/bulkPaymentImportValidation.test.ts
git commit -m "feat: add Bulk Payment Import validation and admission-number lookup"
```

---

### Task 3: Preview endpoint

**Files:**
- Modify: `apps/api/src/routes/fees.ts`
- Test: `apps/api/tests/bulkPaymentImport.test.ts` (new file — DB-integration style, matching `apps/api/tests/staffBulkImport.test.ts` conventions)

**Interfaces:**
- Consumes: `parseBulkPaymentImportFile`, `BulkPaymentImportParseError` (Task 1); `runFullPaymentValidation` (Task 2); `findStudentsByAdmissionNumbers` (Task 2, from `../db/queries/students`); `getInvoiceByStudent` (existing, from `../db/queries/fees`, already imported in this file).
- Produces: `POST /:schoolId/payments-bulk-import/preview` — consumed by the frontend in Task 5.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/bulkPaymentImport.test.ts`:

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
import feesRouter from '../src/routes/fees';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/schools', verifyToken);
app.use('/api/schools', feesRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function xlsxBuffer(headers: string[], rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Payments');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Admission Number', 'Amount', 'Method', 'Payment Date', 'Reference'];

describe('POST /:schoolId/payments-bulk-import/preview', () => {
  let schoolId: string;
  let bursarToken: string;
  let principalToken: string;
  let termId: string;
  let studentAdmissionNo: string;
  let invoiceId: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Payment Bulk Preview Test School', `test-payment-preview-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const bursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Test', 'Bursar', 'subject') RETURNING id, email`,
      [schoolId, `bursar-${randomUUID()}@test.com`]
    );
    bursarToken = makeToken(bursarResult.rows[0].id, 'bursar', schoolId, bursarResult.rows[0].email);

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject') RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, is_current) VALUES ($1, '2026/2027', true) RETURNING id`,
      [schoolId]
    );
    const termResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (school_id, session_id, name, is_current) VALUES ($1, $2, 'First Term', true) RETURNING id`,
      [schoolId, sessionResult.rows[0].id]
    );
    termId = termResult.rows[0].id;

    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'student', 'Ada', 'Obi', 'subject') RETURNING id`,
      [schoolId, `student-${randomUUID()}@test.com`]
    );
    studentAdmissionNo = `SCH/2026/${randomUUID().slice(0, 6).toUpperCase()}`;
    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [schoolId, studentUserResult.rows[0].id, studentAdmissionNo]
    );

    const invoiceResult = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid') RETURNING id`,
      [schoolId, studentResult.rows[0].id, termId]
    );
    invoiceId = invoiceResult.rows[0].id;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM payments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM fee_invoices WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    // pool is NOT closed here — Task 4 adds a sibling describe block below
    // that still needs it. A single top-level afterAll closes it once.
  }, 30000);

  it('rejects a principal with 403 (this feature is bursar-gated, not principal-gated)', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 10000, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid row against an existing invoice', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 10000, 'cash', '2026-01-15', 'Receipt #1']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(res.body.data.rows[0]).toMatchObject({ resolved_invoice_id: invoiceId, resolved_amount: 10000 });
  });

  it('flags a row for a student with no invoice for the chosen term', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['NO-SUCH-ADMISSION-NO', 10000, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('does not match an existing active student');
  });

  it('flags an overpayment relative to the invoice balance', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 999999, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('exceeds the outstanding balance');
  });

  it('rejects a row with method=paystack outright', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 1000, 'paystack', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('Method must be one of');
  });

  it('rejects a missing term_id field', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 1000, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(400);
  });

  it('rejects a workbook with more than 100 rows', async () => {
    const manyRows = Array.from({ length: 101 }, (_, i) => [`ADM-${i}`, 1000, 'cash', '', '']);
    const buffer = await xlsxBuffer(HEADERS, manyRows);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest tests/bulkPaymentImport.test.ts`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 3: Add imports to `apps/api/src/routes/fees.ts`**

Extend the existing imports at the top of the file:

```ts
import multer from 'multer';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import { findStudentsByAdmissionNumbers } from '../db/queries/students';
import { parseBulkPaymentImportFile, BulkPaymentImportParseError } from '../services/bulkPaymentImportParser';
import { runFullPaymentValidation } from '../services/bulkPaymentImportValidation';
```

(`getInvoiceByStudent`, `recordPayment`, `DuplicatePaymentError`, `OverpaymentError` are already imported in this file from `../db/queries/fees` — do not duplicate those imports.)

- [ ] **Step 4: Add the preview route**

Insert immediately before `export default router;` at the end of `apps/api/src/routes/fees.ts`:

```ts
// ── POST /:schoolId/payments-bulk-import/preview ────────────────────────────
// Parses and validates a flat payment spreadsheet without writing anything —
// the bursar confirms via /payments-bulk-import/commit afterward. See
// docs/superpowers/specs/2026-08-31-bulk-payment-import-design.md for the
// full design rationale, including the running-per-student-balance tracking
// that lets two rows for the same student in one file be validated correctly
// against each other without any writes.

const MAX_PAYMENT_BULK_IMPORT_ROWS = 100;
const paymentBulkImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const paymentBulkImportFieldsSchema = z.object({
  term_id: z.string().uuid(),
});

router.post(
  '/:schoolId/payments-bulk-import/preview',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'super_admin'),
  paymentBulkImportUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fields = paymentBulkImportFieldsSchema.safeParse(req.body);
      if (!fields.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'A valid term_id field is required.' } });
      }
      const { term_id } = fields.data;

      const file = req.file;
      if (!file) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No file uploaded. Field name must be "file".' } });
      }

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
        parsedRows = await parseBulkPaymentImportFile(file.buffer, file.originalname);
      } catch (err) {
        if (err instanceof BulkPaymentImportParseError) {
          return res.status(400).json({ success: false, error: { code: 'PARSE_ERROR', message: err.message } });
        }
        return res.status(400).json({
          success: false,
          error: { code: 'PARSE_ERROR', message: 'This file could not be read. Please check it is a valid .xlsx or .csv file.' },
        });
      }

      if (parsedRows.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'EMPTY_FILE', message: 'No payment rows were found in this file.' } });
      }
      if (parsedRows.length > MAX_PAYMENT_BULK_IMPORT_ROWS) {
        return res.status(400).json({
          success: false,
          error: { code: 'TOO_MANY_ROWS', message: `This file has ${parsedRows.length} rows — the maximum per import is ${MAX_PAYMENT_BULK_IMPORT_ROWS}. Split it into multiple files.` },
        });
      }

      const results = await runFullPaymentValidation(parsedRows, {
        lookupStudentsByAdmissionNumbers: (admissionNumbers) => findStudentsByAdmissionNumbers(req.params.schoolId, admissionNumbers),
        lookupInvoiceForStudent: async (studentId) => {
          const invoice = await getInvoiceByStudent(req.params.schoolId, studentId, term_id);
          return invoice ? { id: invoice.id, balance: invoice.balance } : null;
        },
      });

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

Run: `cd apps/api && npx jest tests/bulkPaymentImport.test.ts --runInBand`
Expected: PASS (7 tests)

- [ ] **Step 6: Run typecheck and lint**

Run: `cd apps/api && npx tsc --noEmit && npx eslint src/routes/fees.ts --ext .ts`
Expected: no errors (watch for `no-inner-declarations` — use `const fn = (...) => ...` for any handler-scoped helper, not `function fn() {...}`)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/fees.ts apps/api/tests/bulkPaymentImport.test.ts
git commit -m "feat: add Bulk Payment Import preview endpoint"
```

---

### Task 4: Results generator + commit endpoint + `recordPayment()` payment_date extension

**Files:**
- Modify: `apps/api/src/db/queries/fees.ts` (extend `PaymentInput` and `recordPayment`)
- Create: `apps/api/src/services/bulkPaymentImportResults.ts`
- Modify: `apps/api/src/routes/fees.ts`
- Modify: `apps/api/tests/bulkPaymentImport.test.ts` (add a new `describe` block)
- Test: `apps/api/src/__tests__/feesQueries.test.ts` (add coverage for the `payment_date` extension — this file already exists and already tests `recordPayment`)

**Interfaces:**
- Produces (from `bulkPaymentImportResults.ts`): `generateBulkPaymentImportResultsFile(created: CreatedPaymentRecord[], failed: FailedPaymentRecord[]): Promise<Buffer>`, `CreatedPaymentRecord`, `FailedPaymentRecord`.
- Produces (from the route): `POST /:schoolId/payments-bulk-import/commit` — consumed by the frontend in Task 5.
- Modifies: `PaymentInput` (adds optional `payment_date?: string | null`), `recordPayment()` (existing, from `../db/queries/fees` — passes `payment_date` through to the INSERT when given, unchanged behavior when omitted).

- [ ] **Step 1: Extend `PaymentInput` and `recordPayment()` in `apps/api/src/db/queries/fees.ts`**

Find the `PaymentInput` interface (around line 174) and change it to:

```ts
export interface PaymentInput {
  amount: number;
  method: 'cash' | 'bank_transfer' | 'paystack' | 'waiver';
  reference?: string | null;
  paystack_reference?: string | null;
  recorded_by?: string | null;
  payment_date?: string | null;
}
```

Find the `INSERT INTO payments` statement inside `recordPayment()` (around line 228) and change it to conditionally include `payment_date`:

```ts
    const paymentResult = await client.query<PaymentRow>(
      input.payment_date
        ? `INSERT INTO payments (invoice_id, school_id, amount, method, reference, paystack_reference, recorded_by, payment_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, invoice_id, school_id, amount, payment_date, method, reference, paystack_reference, recorded_by, created_at`
        : `INSERT INTO payments (invoice_id, school_id, amount, method, reference, paystack_reference, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, invoice_id, school_id, amount, payment_date, method, reference, paystack_reference, recorded_by, created_at`,
      input.payment_date
        ? [invoiceId, schoolId, input.amount, input.method, input.reference ?? null, input.paystack_reference ?? null, input.recorded_by ?? null, input.payment_date]
        : [invoiceId, schoolId, input.amount, input.method, input.reference ?? null, input.paystack_reference ?? null, input.recorded_by ?? null]
    );
```

This keeps the live single-item `POST /:schoolId/payments` route's behavior byte-for-byte unchanged (it never passes `payment_date`, so it always takes the second branch, identical to today's query) while letting the bulk-import commit route pass a backdated date.

- [ ] **Step 2: Add a test confirming `payment_date` is honored**

In `apps/api/src/__tests__/feesQueries.test.ts`, find the existing `describe('recordPayment', ...)` block (it already has tests named "inserts a payment and recomputes amount_paid/balance/status on the invoice", "returns null when the invoice does not belong to the school", "rolls back and rethrows on error", "rolls back and throws OverpaymentError when the amount exceeds the outstanding balance" — this file already uses a `makeMockClient()` helper and a `mockConnect` mock, both already defined/imported earlier in the file; do not redefine them) and add this new test inside it, matching the existing tests' exact mock-sequencing style (BEGIN → SELECT FOR UPDATE → duplicate check → INSERT → UPDATE → COMMIT, 6 calls):

```ts
  it('stores a custom payment_date when given, using the payment_date-including INSERT branch', async () => {
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    const paymentRow = {
      id: 'pay-2', invoice_id: 'inv-1', school_id: 'school-1', amount: '5000.00',
      payment_date: '2026-01-15', method: 'cash', reference: null, paystack_reference: null,
      recorded_by: null, created_at: '',
    };
    const updatedInvoice = {
      id: 'inv-1', school_id: 'school-1', student_id: 'student-1', term_id: 'term-1',
      total_amount: '10000.00', amount_paid: '5000.00', balance: '5000.00', status: 'partial',
      created_at: '', updated_at: '',
    };

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ total_amount: '10000.00', amount_paid: '0.00' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // duplicate check (no prior payment)
      .mockResolvedValueOnce({ rows: [paymentRow] }) // INSERT payment
      .mockResolvedValueOnce({ rows: [updatedInvoice] }) // UPDATE invoice
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await recordPayment('school-1', 'inv-1', {
      amount: 5000,
      method: 'cash',
      payment_date: '2026-01-15',
    });

    expect(result).toEqual({ payment: paymentRow, invoice: updatedInvoice });

    // The 4th call (INSERT) must be the payment_date-including branch, with
    // '2026-01-15' present in its param list — proving the caller's date was
    // actually used, not silently dropped in favor of the column default.
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('payment_date'),
      expect.arrayContaining(['2026-01-15'])
    );
  });
```

- [ ] **Step 3: Run the fees queries test file to verify the new test passes and nothing else broke**

Run: `cd apps/api && npx jest src/__tests__/feesQueries.test.ts`
Expected: PASS (all existing tests plus the new one)

- [ ] **Step 4: Write the failing unit test for the results file generator**

Create `apps/api/src/__tests__/bulkPaymentImportResults.test.ts`:

```ts
import ExcelJS from 'exceljs';
import { generateBulkPaymentImportResultsFile } from '../services/bulkPaymentImportResults';

describe('generateBulkPaymentImportResultsFile', () => {
  it('produces a workbook with Summary, Payments Recorded, and Payments Failed sheets', async () => {
    const buffer = await generateBulkPaymentImportResultsFile(
      [{ row_number: 2, admission_no: 'SCH/2024/0001', student_name: 'Ada Obi', amount: 10000, method: 'cash' }],
      [{ row_number: 3, admission_no: 'SCH/2024/0002', amount: '999999', method: 'cash', reason: 'Amount exceeds the outstanding balance.' }]
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Payments Recorded', 'Payments Failed']);
    expect(workbook.getWorksheet('Payments Recorded')!.getRow(2).getCell(2).value).toBe('SCH/2024/0001');
    expect(workbook.getWorksheet('Payments Failed')!.getRow(2).getCell(5).value).toBe('Amount exceeds the outstanding balance.');
  });

  it('handles all-empty inputs without error', async () => {
    const buffer = await generateBulkPaymentImportResultsFile([], []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(3);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd apps/api && npx jest src/__tests__/bulkPaymentImportResults.test.ts`
Expected: FAIL with "Cannot find module '../services/bulkPaymentImportResults'"

- [ ] **Step 6: Write the results file generator**

Create `apps/api/src/services/bulkPaymentImportResults.ts`:

```ts
import ExcelJS from 'exceljs';

export interface CreatedPaymentRecord {
  row_number: number;
  admission_no: string;
  student_name: string;
  amount: number;
  method: string;
}

export interface FailedPaymentRecord {
  row_number: number;
  admission_no: string;
  amount: string;
  method: string;
  reason: string;
}

export async function generateBulkPaymentImportResultsFile(
  created: CreatedPaymentRecord[],
  failed: FailedPaymentRecord[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Bulk Payment Import Results']);
  summary.addRow([`${created.length} payment(s) recorded, ${failed.length} row(s) failed.`]);

  const recordedSheet = workbook.addWorksheet('Payments Recorded');
  recordedSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Admission Number', key: 'admission_no', width: 20 },
    { header: 'Student Name', key: 'student_name', width: 24 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Method', key: 'method', width: 14 },
  ];
  created.forEach(c => recordedSheet.addRow(c));

  const failedSheet = workbook.addWorksheet('Payments Failed');
  failedSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Admission Number', key: 'admission_no', width: 20 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Method', key: 'method', width: 14 },
    { header: 'Reason', key: 'reason', width: 50 },
  ];
  failed.forEach(f => failedSheet.addRow(f));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd apps/api && npx jest src/__tests__/bulkPaymentImportResults.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Write the failing integration test for the commit endpoint**

Add to `apps/api/tests/bulkPaymentImport.test.ts`, in a new `describe` block below the existing one (reusing the `app`, `makeToken`, `xlsxBuffer`, `HEADERS` helpers already defined in that file — do not redeclare). Also add a top-level `afterAll` that closes the pool once, after this new block:

```ts
describe('POST /:schoolId/payments-bulk-import/commit', () => {
  let schoolId: string;
  let bursarToken: string;
  let principalToken: string;
  let termId: string;
  let studentAdmissionNo: string;
  let invoiceId: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Payment Bulk Commit Test School', `test-payment-commit-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const bursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Test', 'Bursar', 'subject') RETURNING id, email`,
      [schoolId, `bursar-commit-${randomUUID()}@test.com`]
    );
    bursarToken = makeToken(bursarResult.rows[0].id, 'bursar', schoolId, bursarResult.rows[0].email);

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject') RETURNING id, email`,
      [schoolId, `principal-commit-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, is_current) VALUES ($1, '2026/2027', true) RETURNING id`,
      [schoolId]
    );
    const termResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (school_id, session_id, name, is_current) VALUES ($1, $2, 'First Term', true) RETURNING id`,
      [schoolId, sessionResult.rows[0].id]
    );
    termId = termResult.rows[0].id;

    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'student', 'Chidi', 'Eze', 'subject') RETURNING id`,
      [schoolId, `student-commit-${randomUUID()}@test.com`]
    );
    studentAdmissionNo = `SCH/2026/${randomUUID().slice(0, 6).toUpperCase()}`;
    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [schoolId, studentUserResult.rows[0].id, studentAdmissionNo]
    );

    const invoiceResult = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid') RETURNING id`,
      [schoolId, studentResult.rows[0].id, termId]
    );
    invoiceId = invoiceResult.rows[0].id;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM payments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM fee_invoices WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    return res.body.data;
  }

  it('rejects a principal with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ term_id: termId, rows: [] });
    expect(res.status).toBe(403);
  });

  it('records a valid payment end-to-end, including a backdated payment_date', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 15000, 'cash', '2026-01-10', 'Receipt #99']]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/commit`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ term_id: termId, rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(0);
    expect(typeof commit.body.data.download_base64).toBe('string');

    const paymentRow = await pool.query(`SELECT amount, method, payment_date, reference FROM payments WHERE invoice_id = $1`, [invoiceId]);
    expect(paymentRow.rows).toHaveLength(1);
    expect(Number(paymentRow.rows[0].amount)).toBe(15000);
    expect(paymentRow.rows[0].reference).toBe('Receipt #99');
    expect(new Date(paymentRow.rows[0].payment_date).toISOString().slice(0, 10)).toBe('2026-01-10');

    const invoiceRow = await pool.query(`SELECT amount_paid, balance, status FROM fee_invoices WHERE id = $1`, [invoiceId]);
    expect(Number(invoiceRow.rows[0].amount_paid)).toBe(15000);
    expect(Number(invoiceRow.rows[0].balance)).toBe(35000);
    expect(invoiceRow.rows[0].status).toBe('partial');
  }, 30000);

  it('does not stop the batch when one row fails and a second, different-student row succeeds', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['NO-SUCH-ADMISSION', 5000, 'cash', '', ''],
      [studentAdmissionNo, 5000, 'bank_transfer', '', ''],
    ]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 2, valid: 1, invalid: 1 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/commit`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ term_id: termId, rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(1);
  }, 30000);
});

// Closes the shared pg pool once, after every describe block in this file has
// finished — closing it inside an individual describe's afterAll would break
// any sibling describe block that still needs to query the database.
afterAll(async () => {
  await pool.end();
});
```

- [ ] **Step 9: Run tests to verify they fail**

Run: `cd apps/api && npx jest tests/bulkPaymentImport.test.ts --runInBand -t "commit"`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 10: Add imports and the commit route to `apps/api/src/routes/fees.ts`**

Extend the imports at the top of the file:

```ts
import { generateBulkPaymentImportResultsFile, type CreatedPaymentRecord, type FailedPaymentRecord } from '../services/bulkPaymentImportResults';
```

Insert immediately after the preview route added in Task 3, before `export default router;`:

```ts
// ── POST /:schoolId/payments-bulk-import/commit ─────────────────────────────
// Re-validates every row from scratch — never trusts the client-supplied
// "valid"/"error" status from preview. Each valid row's actual write goes
// through the same recordPayment() the live single-item endpoint uses, so
// duplicate-detection and overpayment safety are identical to a bursar
// recording one payment by hand — this route just loops it.

const paymentBulkImportRowSchema = z.object({
  row_number: z.number(),
  status: z.enum(['valid', 'error']),
  errors: z.array(z.string()),
  payment: z.object({
    row_number: z.number(),
    admission_no: z.string(),
    amount: z.string(),
    method: z.string(),
    payment_date: z.string().nullable(),
    reference: z.string().nullable(),
  }),
  resolved_student_id: z.string().nullable(),
  resolved_invoice_id: z.string().nullable(),
  resolved_amount: z.number().nullable(),
});

const paymentBulkImportCommitSchema = z.object({
  term_id: z.string().uuid(),
  rows: z.array(paymentBulkImportRowSchema).min(1).max(MAX_PAYMENT_BULK_IMPORT_ROWS),
});

router.post(
  '/:schoolId/payments-bulk-import/commit',
  verifyToken,
  requireSchoolAccess,
  requireRole('bursar', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = paymentBulkImportCommitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
      }
      const { term_id } = parsed.data;

      const submittedRows = parsed.data.rows.map(r => r.payment);
      const revalidated = await runFullPaymentValidation(submittedRows, {
        lookupStudentsByAdmissionNumbers: (admissionNumbers) => findStudentsByAdmissionNumbers(req.params.schoolId, admissionNumbers),
        lookupInvoiceForStudent: async (studentId) => {
          const invoice = await getInvoiceByStudent(req.params.schoolId, studentId, term_id);
          return invoice ? { id: invoice.id, balance: invoice.balance } : null;
        },
      });

      // Re-resolve student names for the results file — runFullPaymentValidation
      // only returns ids, not names, to stay DB-shape-agnostic.
      const admissionNumbers = [...new Set(revalidated.map(r => r.payment.admission_no).filter(Boolean))];
      const students = await findStudentsByAdmissionNumbers(req.params.schoolId, admissionNumbers);

      const results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }> = [];
      const createdPayments: CreatedPaymentRecord[] = [];
      const failedPayments: FailedPaymentRecord[] = [];

      for (const row of revalidated) {
        const student = students.get(row.payment.admission_no);
        const studentName = student ? `${student.first_name} ${student.last_name}` : row.payment.admission_no;

        if (row.status === 'error' || !row.resolved_invoice_id || row.resolved_amount === null) {
          const reason = row.errors.join(' ') || 'Could not be recorded.';
          results.push({ row_number: row.row_number, status: 'failed', reason });
          failedPayments.push({ row_number: row.row_number, admission_no: row.payment.admission_no, amount: row.payment.amount, method: row.payment.method, reason });
          continue;
        }

        try {
          await recordPayment(req.params.schoolId, row.resolved_invoice_id, {
            amount: row.resolved_amount,
            method: row.payment.method as 'cash' | 'bank_transfer' | 'waiver',
            reference: row.payment.reference,
            paystack_reference: null,
            recorded_by: req.user!.user_id,
            payment_date: row.payment.payment_date,
          });

          await logAudit({
            supportSession: req.supportSession,
            schoolId: req.params.schoolId,
            userId: req.user!.user_id,
            actionType: 'PAYMENT_RECORDED',
            entity: 'payments',
            entityId: row.resolved_invoice_id,
            newValue: { admission_no: row.payment.admission_no, amount: row.resolved_amount, method: row.payment.method },
          });

          results.push({ row_number: row.row_number, status: 'created' });
          createdPayments.push({
            row_number: row.row_number,
            admission_no: row.payment.admission_no,
            student_name: studentName,
            amount: row.resolved_amount,
            method: row.payment.method,
          });
        } catch (err: unknown) {
          const reason = err instanceof DuplicatePaymentError || err instanceof OverpaymentError
            ? err.message
            : 'Failed to record this payment.';
          results.push({ row_number: row.row_number, status: 'failed', reason });
          failedPayments.push({ row_number: row.row_number, admission_no: row.payment.admission_no, amount: row.payment.amount, method: row.payment.method, reason });
        }
      }

      const resultsFile = await generateBulkPaymentImportResultsFile(createdPayments, failedPayments);

      await logAudit({
        supportSession: req.supportSession,
        schoolId: req.params.schoolId,
        userId: req.user!.user_id,
        actionType: 'PAYMENT_BULK_IMPORT',
        entity: 'payments',
        entityId: req.params.schoolId,
        newValue: { created: createdPayments.length, failed: failedPayments.length, term_id },
      });

      return res.json({
        success: true,
        data: {
          created: createdPayments.length,
          failed: failedPayments.length,
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

- [ ] **Step 11: Run tests to verify they pass**

Run: `cd apps/api && npx jest tests/bulkPaymentImport.test.ts --runInBand`
Expected: PASS (all tests in the file — preview + commit describe blocks)

- [ ] **Step 12: Run typecheck and lint**

Run: `cd apps/api && npx tsc --noEmit && npx eslint src/routes/fees.ts --ext .ts && npx eslint src/db/queries/fees.ts --ext .ts`
Expected: no errors

- [ ] **Step 13: Before committing, check for and clean up orphaned test data**

```bash
cd apps/api && node -e "
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const schools = await pool.query(\"SELECT id FROM schools WHERE name LIKE 'Payment Bulk%'\");
  const ids = schools.rows.map(r => r.id);
  console.log('found:', ids.length);
  if (ids.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM payments WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM fee_invoices WHERE school_id = ANY(\$1::uuid[])', [ids]);
    await pool.query('DELETE FROM students WHERE school_id = ANY(\$1::uuid[])', [ids]);
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

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/db/queries/fees.ts apps/api/src/services/bulkPaymentImportResults.ts apps/api/src/routes/fees.ts apps/api/tests/bulkPaymentImport.test.ts apps/api/src/__tests__/bulkPaymentImportResults.test.ts apps/api/src/__tests__/feesQueries.test.ts
git commit -m "feat: add Bulk Payment Import commit endpoint, results file, and payment_date support"
```

---

### Task 5: Frontend — template asset + the import page

**Files:**
- Create: `apps/web/public/templates/payment-bulk-import-template.xlsx` (generated once via a temporary script, then committed as a static asset)
- Create: `apps/web/app/(dashboard)/bursar/fee-structures/import/page.tsx`

**Interfaces:**
- Consumes: `POST /:schoolId/payments-bulk-import/preview` and `POST /:schoolId/payments-bulk-import/commit` (Tasks 3 and 4) via `apiUpload`/`apiFetch` (`apps/web/lib/api.ts`, existing); `useTermsAndClasses`, `TermOption` (existing, from `apps/web/app/(dashboard)/bursar/shared.tsx`).

- [ ] **Step 1: Generate the template file**

Create a temporary script at the repo root, `_gen-payment-template.js` (deleted in Step 3 — not part of the final commit):

```js
const ExcelJS = require('exceljs');

async function main() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Payments');
  sheet.columns = [
    { header: 'Admission Number', key: 'admission_no', width: 22 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Method', key: 'method', width: 16 },
    { header: 'Payment Date', key: 'payment_date', width: 16 },
    { header: 'Reference', key: 'reference', width: 24 },
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
  sheet.addRow({
    admission_no: 'DELETE-THIS-ROW',
    amount: 0,
    method: 'cash',
    payment_date: '2026-01-01',
    reference: 'EXAMPLE — delete this row',
  });

  await wb.xlsx.writeFile(process.argv[2]);
  console.log('Template written to', process.argv[2]);
}

main();
```

Run (from repo root):

```bash
mkdir -p apps/web/public/templates
node _gen-payment-template.js apps/web/public/templates/payment-bulk-import-template.xlsx
```

The example row uses the established obviously-fake-placeholder convention (`DELETE-THIS-ROW`, `EXAMPLE`) — never realistic-looking data. Amount is `0` in the example specifically so that if a user forgets to delete the row, it fails validation loudly (Amount must be a positive number) rather than silently importing a bogus ₦0 payment.

- [ ] **Step 2: Verify the template manually**

Open `apps/web/public/templates/payment-bulk-import-template.xlsx` and confirm: one sheet named `Payments`; 5 correctly-labeled columns; one obviously-placeholder example row.

- [ ] **Step 3: Delete the temporary script**

```bash
rm _gen-payment-template.js
```

- [ ] **Step 4: Write the import page**

Create `apps/web/app/(dashboard)/bursar/fee-structures/import/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/providers';
import { apiFetch, apiUpload } from '@/lib/api';
import { useTermsAndClasses } from '../../shared';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedPayment {
  row_number: number;
  admission_no: string;
  amount: string;
  method: string;
  payment_date: string | null;
  reference: string | null;
}

interface PaymentRow {
  row_number: number;
  status: 'valid' | 'error';
  errors: string[];
  payment: ParsedPayment;
  resolved_student_id: string | null;
  resolved_invoice_id: string | null;
  resolved_amount: number | null;
}

interface PreviewResponse {
  rows: PaymentRow[];
  summary: { total: number; valid: number; invalid: number };
}

interface CommitResponse {
  created: number;
  failed: number;
  results: Array<{ row_number: number; status: 'created' | 'failed'; reason?: string }>;
  download_base64: string;
}

type Step = 'select-term' | 'upload' | 'preview' | 'done';

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

export default function PaymentBulkImportPage() {
  const { schoolId } = useAuth();
  const { terms, currentTermId, loading: termsLoading } = useTermsAndClasses();
  const [termId, setTermId] = useState('');
  const [step, setStep] = useState<Step>('select-term');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
  const [commitError, setCommitError] = useState('');

  const effectiveTermId = termId || currentTermId || '';

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !file || !effectiveTermId) return;
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('term_id', effectiveTermId);
      const res = await apiUpload<{ success: boolean; data: PreviewResponse }>(
        `/api/schools/${schoolId}/payments-bulk-import/preview`,
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
    if (!schoolId || !preview || !effectiveTermId) return;
    setCommitting(true);
    setCommitError('');
    try {
      const res = await apiFetch<{ success: boolean; data: CommitResponse }>(
        `/api/schools/${schoolId}/payments-bulk-import/commit`,
        { method: 'POST', body: JSON.stringify({ term_id: effectiveTermId, rows: preview.rows.filter(r => r.status === 'valid') }) }
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
        <Link href="/bursar/fee-structures" className="text-sm text-[#2472B4] hover:underline">← Back to Fee Structures</Link>
        <h1 className="text-xl font-semibold text-gray-900 mt-2">Bulk Import Payments</h1>
        <p className="text-sm text-gray-500 mt-1">Record historical payments (cash, bank transfer, or waiver) against existing invoices for one term — up to 100 rows per import.</p>
      </div>

      {(step === 'select-term' || step === 'upload') && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Term</label>
            <select
              value={effectiveTermId}
              onChange={e => setTermId(e.target.value)}
              disabled={termsLoading}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Select a term…</option>
              {terms.map(t => (
                <option key={t.id} value={t.id}>{t.sessionName} — {t.name}{t.isCurrent ? ' (current)' : ''}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">Every row in the file must have an existing invoice for this term — generate invoices first if needed.</p>
          </div>

          <a
            href="/templates/payment-bulk-import-template.xlsx"
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
              disabled={!file || !effectiveTermId || uploading}
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
              <h3 className="text-sm font-semibold text-gray-900">Payments</h3>
              <span className="text-xs text-gray-500">{preview.summary.valid} of {preview.summary.total} valid</span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                {preview.rows.map(r => (
                  <tr key={r.row_number}>
                    <td className="px-4 py-2 text-gray-500 w-16">{r.row_number}</td>
                    <td className="px-4 py-2">{r.payment.admission_no} — ₦{r.payment.amount} ({r.payment.method})</td>
                    <td className="px-4 py-2 w-64">
                      {r.status === 'valid' ? (
                        <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1">Will record</span>
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
              onClick={() => { setStep('select-term'); setFile(null); setPreview(null); }}
              className="px-5 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <p className="text-lg font-semibold text-gray-900">{commitResult.created} payment(s) recorded</p>
          {commitResult.failed > 0 && (
            <div className="space-y-1">
              {commitResult.results.filter(r => r.status === 'failed').map(r => (
                <p key={r.row_number} className="text-sm text-red-700">Row {r.row_number}: {r.reason}</p>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => downloadBase64File(commitResult.download_base64, 'chronix-edu-payment-bulk-import-results.xlsx')}
            className="px-5 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700"
          >
            Download results (.xlsx)
          </button>
          <div>
            <Link href="/bursar/fee-structures" className="text-sm text-[#2472B4] hover:underline">← Back to Fee Structures</Link>
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
git add apps/web/public/templates/payment-bulk-import-template.xlsx "apps/web/app/(dashboard)/bursar/fee-structures/import/page.tsx"
git commit -m "feat: add Bulk Payment Import page and downloadable template"
```

---

### Task 6: Entry point on the Fee Structures page, row-cap timing measurement, and full manual verification

**Files:**
- Modify: `apps/web/app/(dashboard)/bursar/fee-structures/page.tsx`

**Interfaces:**
- Consumes: the page created in Task 5 (`/bursar/fee-structures/import`).

- [ ] **Step 1: Add the `Link` import and the "Bulk Import Payments" entry-point link**

In `apps/web/app/(dashboard)/bursar/fee-structures/page.tsx`, add to the top of the existing import block:

```tsx
import Link from 'next/link';
```

Find the header's action-button group (around lines 83-99):

```tsx
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowGenerateModal(true)}
            disabled={!termId}
            className="btn-secondary"
          >
            Generate Invoices
          </button>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            disabled={!termId}
            className="btn-primary"
          >
            + Add Fee Component
          </button>
```

Add a "Bulk Import Payments" link into that same group, before the "Generate Invoices" button:

```tsx
        <div className="flex flex-wrap gap-2">
          <Link href="/bursar/fee-structures/import" className="btn-secondary">
            Bulk Import Payments
          </Link>
          <button
            type="button"
            onClick={() => setShowGenerateModal(true)}
            disabled={!termId}
            className="btn-secondary"
          >
            Generate Invoices
          </button>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            disabled={!termId}
            className="btn-primary"
          >
            + Add Fee Component
          </button>
```

(This page already uses a `btn-secondary`/`btn-primary` CSS-class convention, unlike the raw-Tailwind-class buttons on the Roster/Users/Students pages — follow this file's own established convention, not the other pages'.)

- [ ] **Step 2: Run typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Full backend test suite**

Run: `cd apps/api && npx jest --runInBand`
Expected: all suites pass (existing suites unaffected + all new Bulk Payment Import tests from Tasks 1-4). If `tests/studentsBulkImport.test.ts` fails on "accepts a full 50-row batch" (expects 50 created, gets fewer), this is a known, pre-existing, unrelated issue in a different feature — confirm via isolated re-run that it reproduces identically and is not something this plan's changes could cause (this plan never touches `routes/students.ts` or `registerStudent`), then proceed; do not attempt to fix it here.

- [ ] **Step 4: Row-cap timing measurement (required — do not skip)**

The spec's row cap of 100 is a starting value pending a real measurement. Each row is one `recordPayment()` transaction (DB-only, no external API calls) — likely faster per-row than Students & Parents' `registerStudent()` (which does more inserts per row) and much faster than Staff/Users' Supabase-Auth-per-row calls, but measure rather than assume:

1. Write a standalone throwaway script (e.g. `apps/api/_measure_payment_bulk_timing.ts`, deleted after running) that creates a test school with a term and 100 students (each with an invoice with a large enough balance), builds a 100-row in-memory `.xlsx` buffer of valid payment rows (one per student, distinct admission numbers), calls the commit endpoint's logic directly (or via an HTTP request to a locally-running server) with `console.time`/`console.timeEnd` around the full batch, and reports total elapsed time and average per-row time. Run it at least twice to check for variance, following the same rigor as Staff/Users' Task 6 (which ran 3 measurements rather than trusting a single data point).
2. **If 100 rows completes comfortably under ~3 minutes**: keep `MAX_PAYMENT_BULK_IMPORT_ROWS = 100` as-is in `apps/api/src/routes/fees.ts`. No code change needed.
3. **If it takes meaningfully longer**: lower `MAX_PAYMENT_BULK_IMPORT_ROWS` in `apps/api/src/routes/fees.ts` (both the preview route's constant and the `paymentBulkImportCommitSchema`'s `.max(...)`) to a value that keeps the full batch comfortably under budget. Update the frontend copy in `apps/web/app/(dashboard)/bursar/fee-structures/import/page.tsx` ("up to 100 rows per import") to match. Re-run the full backend test suite (Step 3) after any cap change, since the "rejects a workbook with more than 100 rows" test in Task 3 hardcodes 100 rows and would need updating to `MAX_PAYMENT_BULK_IMPORT_ROWS + 1` rows.
4. Delete the throwaway measurement script — never commit it.
5. Report the measured timing and final cap value.

- [ ] **Step 5: Manual end-to-end verification**

Write a standalone verification script (same pattern used for the three prior bulk-import features — a throwaway `ts-node` script at `apps/api/_e2e_verify_payments.ts`, deleted after running) that:
1. Creates a test school, a bursar account, a term, a student with a known admission number, and generates an invoice for that student/term with a real total_amount (via `generateInvoices` or a direct insert matching its shape).
2. Loads the real downloadable template file (`apps/web/public/templates/payment-bulk-import-template.xlsx`) — but since its one example row is intentionally invalid (Amount = 0, admission_no = "DELETE-THIS-ROW", designed to fail loudly if left in place), build a small in-memory workbook instead that mirrors the template's columns with one genuinely valid row referencing the test student, to exercise the real flow end-to-end.
3. Runs it through preview with the test term_id — confirms the row is `valid` with the correct `resolved_invoice_id`/`resolved_amount`.
4. Commits it — confirms `created: 1, failed: 0`; confirms a `payments` row exists with the correct amount/method/reference and (if a Payment Date was included) the correct backdated `payment_date`; confirms the `fee_invoices` row's `amount_paid`/`balance`/`status` were correctly recomputed.
5. Confirms the results file from the commit decodes as a valid `.xlsx` (starts with the `PK` zip signature) and contains the payment in its "Payments Recorded" sheet.
6. Cleans up all test data created (audit_logs, payments, fee_invoices, students, terms, academic_sessions, users, school) in FK-safe order.

Run it, confirm every step passes, then delete the script (never committed).

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(dashboard)/bursar/fee-structures/page.tsx"
git commit -m "feat: add Bulk Import Payments entry point to the Fee Structures page"
```

---

## Self-Review Notes

- **Spec coverage:** file parsing (Task 1), admission-number lookup + validation with running-per-student-balance tracking (Task 2), the preview endpoint with the 100-row cap, term-selection field, and magic-byte check (Task 3), the `recordPayment()` `payment_date` extension + commit endpoint (reusing `recordPayment()` per row, never reimplementing invoice math) + results file with both created and failed sheets from the start (Task 4), the frontend page with its term dropdown + branded template (Task 5), and the entry point + required row-cap timing measurement + full end-to-end verification (Task 6) — every section of the spec maps to a task.
- **Reuse over duplication:** `recordPayment()`, `getInvoiceByStudent()`, `DuplicatePaymentError`, `OverpaymentError` (all existing, from `db/queries/fees.ts`) are imported and reused, not reimplemented — the bulk commit route is a loop around the same function the live single-item endpoint calls, inheriting its transactional safety, duplicate detection, and overpayment guard for free.
- **Type consistency checked:** `ParsedPaymentRow` (Task 1) flows unchanged into `PaymentValidationResult.payment` (Task 2), which flows unchanged into the preview response shape and the commit request Zod schema (Tasks 3-4) and the frontend's `ParsedPayment`/`PaymentRow` interfaces (Task 5) — field names match end to end.
- **No placeholders:** every step has real, complete code.
- **Lesson carried forward from Staff/Users' final review**: the results file (Task 4) includes both "Payments Recorded" and "Payments Failed" sheets from the start, and the frontend (Task 5) renders failure reasons inline from the start — the Staff/Users plan had to fix both of these after the fact when its final whole-branch review caught the gap; this plan builds them in directly.
