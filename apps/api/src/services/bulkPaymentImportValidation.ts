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
  const students = admissionNumbers.length > 0
    ? await deps.lookupStudentsByAdmissionNumbers(admissionNumbers)
    : new Map<string, { id: string; first_name: string; last_name: string }>();

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
