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

  it('does not decrement the running balance for a row that has an unrelated error', async () => {
    const deps = baseDeps({ lookupInvoiceForStudent: async () => ({ id: 'invoice-1', balance: 1000 }) });
    const rows = [
      row({ row_number: 2, amount: '700', method: 'paystack' }),
      row({ row_number: 3, amount: '700', method: 'cash' }),
    ];
    const results = await runFullPaymentValidation(rows, deps);
    expect(results[0].status).toBe('error');
    expect(results[0].errors[0]).toContain('Method must be one of');
    expect(results[1].status).toBe('valid');
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
