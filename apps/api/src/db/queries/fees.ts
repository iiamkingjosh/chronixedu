import pool from '../client';

export class DuplicatePaymentError extends Error {
  code = 'DUPLICATE_PAYMENT';
  constructor() {
    super('A duplicate cash/bank-transfer payment for this invoice was recorded within the last 5 minutes');
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FeeStructureRow {
  id: string;
  school_id: string;
  class_id: string | null;
  term_id: string;
  component_name: string;
  amount: number;
  is_mandatory: boolean;
  created_at: string;
}

export interface FeeStructureInput {
  class_id: string | null;
  term_id: string;
  component_name: string;
  amount: number;
  is_mandatory: boolean;
}

// ── Fee structures ─────────────────────────────────────────────────────────────

export async function insertFeeStructure(schoolId: string, input: FeeStructureInput): Promise<FeeStructureRow> {
  const result = await pool.query<FeeStructureRow>(
    `INSERT INTO fee_structures (school_id, class_id, term_id, component_name, amount, is_mandatory)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, school_id, class_id, term_id, component_name, amount, is_mandatory, created_at`,
    [schoolId, input.class_id, input.term_id, input.component_name, input.amount, input.is_mandatory]
  );
  return result.rows[0];
}

export async function listFeeStructures(
  schoolId: string,
  termId: string,
  classId?: string | null
): Promise<FeeStructureRow[]> {
  const params: unknown[] = [schoolId, termId];
  let classCondition = '';
  if (classId) {
    params.push(classId);
    classCondition = ` AND (class_id = $${params.length} OR class_id IS NULL)`;
  }

  const result = await pool.query<FeeStructureRow>(
    `SELECT id, school_id, class_id, term_id, component_name, amount, is_mandatory, created_at
     FROM fee_structures
     WHERE school_id = $1 AND term_id = $2${classCondition}
     ORDER BY component_name`,
    params
  );
  return result.rows;
}

// ── Invoices ───────────────────────────────────────────────────────────────────

export interface FeeInvoiceRow {
  id: string;
  school_id: string;
  student_id: string;
  term_id: string;
  total_amount: number;
  amount_paid: number;
  balance: number;
  status: 'unpaid' | 'partial' | 'paid';
  created_at: string;
  updated_at: string | null;
}

/** Generates/upserts a fee_invoices row for every student enrolled in classId for termId.
 *  Returns null if termId does not belong to schoolId. */
export async function generateInvoices(
  schoolId: string,
  termId: string,
  classId: string
): Promise<FeeInvoiceRow[] | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const termResult = await client.query<{ session_id: string }>(
      `SELECT session_id FROM terms WHERE id = $1 AND school_id = $2`,
      [termId, schoolId]
    );
    const sessionId = termResult.rows[0]?.session_id;
    if (!sessionId) {
      await client.query('ROLLBACK');
      return null;
    }

    const totalResult = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM fee_structures
       WHERE school_id = $1 AND term_id = $2 AND is_mandatory = TRUE
         AND (class_id = $3 OR class_id IS NULL)`,
      [schoolId, termId, classId]
    );
    const totalAmount = Number(totalResult.rows[0]?.total ?? 0);

    const studentsResult = await client.query<{ id: string }>(
      `SELECT s.id
       FROM students s
       JOIN student_classes sc ON sc.student_id = s.id
       WHERE s.school_id = $1 AND sc.class_id = $2 AND sc.session_id = $3`,
      [schoolId, classId, sessionId]
    );

    const invoices: FeeInvoiceRow[] = [];
    for (const student of studentsResult.rows) {
      const result = await client.query<FeeInvoiceRow>(
        `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
         VALUES ($1, $2, $3, $4, 0, $4, 'unpaid'::chronixedu_invoice_status)
         ON CONFLICT (student_id, term_id) DO UPDATE
         SET total_amount = EXCLUDED.total_amount,
             balance = EXCLUDED.total_amount - fee_invoices.amount_paid,
             status = CASE
               WHEN fee_invoices.amount_paid <= 0 THEN 'unpaid'::chronixedu_invoice_status
               WHEN fee_invoices.amount_paid >= EXCLUDED.total_amount THEN 'paid'::chronixedu_invoice_status
               ELSE 'partial'::chronixedu_invoice_status
             END,
             updated_at = NOW()
         RETURNING id, school_id, student_id, term_id, total_amount, amount_paid, balance, status, created_at, updated_at`,
        [schoolId, student.id, termId, totalAmount]
      );
      invoices.push(result.rows[0]);
    }

    await client.query('COMMIT');
    return invoices;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Payments ───────────────────────────────────────────────────────────────────

export interface PaymentRow {
  id: string;
  invoice_id: string;
  school_id: string;
  amount: number;
  payment_date: string;
  method: 'cash' | 'bank_transfer' | 'paystack' | 'waiver';
  reference: string | null;
  paystack_reference: string | null;
  recorded_by: string | null;
  created_at: string;
}

export interface InvoiceWithPayments extends FeeInvoiceRow {
  payments: PaymentRow[];
}

export interface PaymentInput {
  amount: number;
  method: 'cash' | 'bank_transfer' | 'paystack' | 'waiver';
  reference?: string | null;
  paystack_reference?: string | null;
  recorded_by?: string | null;
}

export function deriveStatus(totalAmount: number, amountPaid: number): 'unpaid' | 'partial' | 'paid' {
  if (amountPaid <= 0) return 'unpaid';
  if (amountPaid >= totalAmount) return 'paid';
  return 'partial';
}

/** Records a payment against an invoice and recomputes amount_paid/balance/status.
 *  Returns null if invoiceId does not belong to schoolId. */
export async function recordPayment(
  schoolId: string,
  invoiceId: string,
  input: PaymentInput
): Promise<{ payment: PaymentRow; invoice: FeeInvoiceRow } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invoiceResult = await client.query<{ total_amount: string; amount_paid: string }>(
      `SELECT total_amount, amount_paid FROM fee_invoices WHERE id = $1 AND school_id = $2 FOR UPDATE`,
      [invoiceId, schoolId]
    );
    const invoiceRow = invoiceResult.rows[0];
    if (!invoiceRow) {
      await client.query('ROLLBACK');
      return null;
    }

    // Idempotency guard: reject duplicate cash/bank_transfer payments within 5 minutes.
    if (input.method === 'cash' || input.method === 'bank_transfer') {
      const dupeResult = await client.query(
        `SELECT id FROM payments WHERE invoice_id = $1 AND method = $2 AND amount = $3
         AND created_at > NOW() - INTERVAL '5 minutes'`,
        [invoiceId, input.method, input.amount]
      );
      if (dupeResult.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new DuplicatePaymentError();
      }
    }

    const paymentResult = await client.query<PaymentRow>(
      `INSERT INTO payments (invoice_id, school_id, amount, method, reference, paystack_reference, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, invoice_id, school_id, amount, payment_date, method, reference, paystack_reference, recorded_by, created_at`,
      [
        invoiceId,
        schoolId,
        input.amount,
        input.method,
        input.reference ?? null,
        input.paystack_reference ?? null,
        input.recorded_by ?? null,
      ]
    );
    const payment = paymentResult.rows[0];

    const totalAmount = Number(invoiceRow.total_amount);
    const newAmountPaid = Number(invoiceRow.amount_paid) + input.amount;
    const balance = totalAmount - newAmountPaid;
    const status = deriveStatus(totalAmount, newAmountPaid);

    const invoiceUpdateResult = await client.query<FeeInvoiceRow>(
      `UPDATE fee_invoices
       SET amount_paid = $1, balance = $2, status = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, school_id, student_id, term_id, total_amount, amount_paid, balance, status, created_at, updated_at`,
      [newAmountPaid, balance, status, invoiceId]
    );

    await client.query('COMMIT');
    return { payment, invoice: invoiceUpdateResult.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface PaymentReceiptRow extends PaymentRow {
  student_id: string;
  total_amount: number;
  amount_paid: number;
  balance: number;
  invoice_status: 'unpaid' | 'partial' | 'paid';
  first_name: string;
  last_name: string;
  admission_no: string;
  class_name: string | null;
  term_name: string;
  session_name: string;
}

/** Fetches a payment together with the invoice/student/term details needed to render a receipt.
 *  Returns null if paymentId does not belong to schoolId. */
export async function getPaymentById(schoolId: string, paymentId: string): Promise<PaymentReceiptRow | null> {
  const result = await pool.query<PaymentReceiptRow>(
    `SELECT
       p.id, p.invoice_id, p.school_id, p.amount, p.payment_date, p.method,
       p.reference, p.paystack_reference, p.recorded_by, p.created_at,
       fi.student_id,
       fi.total_amount, fi.amount_paid, fi.balance, fi.status AS invoice_status,
       u.first_name, u.last_name, s.admission_no,
       c.name AS class_name,
       t.name AS term_name, sess.name AS session_name
     FROM payments p
     JOIN fee_invoices fi ON fi.id = p.invoice_id
     JOIN students s ON s.id = fi.student_id
     JOIN users u ON u.id = s.user_id
     JOIN terms t ON t.id = fi.term_id
     JOIN sessions sess ON sess.id = t.session_id
     LEFT JOIN student_classes sc ON sc.student_id = fi.student_id AND sc.session_id = t.session_id
     LEFT JOIN classes c ON c.id = sc.class_id
     WHERE p.id = $1 AND p.school_id = $2`,
    [paymentId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function getInvoiceByStudent(
  schoolId: string,
  studentId: string,
  termId: string
): Promise<InvoiceWithPayments | null> {
  const invoiceResult = await pool.query<FeeInvoiceRow>(
    `SELECT id, school_id, student_id, term_id, total_amount, amount_paid, balance, status, created_at, updated_at
     FROM fee_invoices
     WHERE school_id = $1 AND student_id = $2 AND term_id = $3`,
    [schoolId, studentId, termId]
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) return null;

  const paymentsResult = await pool.query<PaymentRow>(
    `SELECT id, invoice_id, school_id, amount, payment_date, method, reference, paystack_reference, recorded_by, created_at
     FROM payments
     WHERE invoice_id = $1
     ORDER BY payment_date`,
    [invoice.id]
  );

  return { ...invoice, payments: paymentsResult.rows };
}

export interface InvoiceListRow {
  id: string;
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  class_name: string | null;
  total_amount: number;
  amount_paid: number;
  balance: number;
  status: 'unpaid' | 'partial' | 'paid';
}

export async function listInvoices(
  schoolId: string,
  termId: string,
  filters?: { classId?: string | null; status?: 'unpaid' | 'partial' | 'paid' }
): Promise<InvoiceListRow[]> {
  const params: unknown[] = [schoolId, termId];
  let conditions = '';

  if (filters?.classId) {
    params.push(filters.classId);
    conditions += ` AND sc.class_id = $${params.length}`;
  }

  if (filters?.status) {
    params.push(filters.status);
    conditions += ` AND fi.status = $${params.length}::chronixedu_invoice_status`;
  }

  const result = await pool.query<InvoiceListRow>(
    `SELECT
       fi.id, fi.student_id, u.first_name, u.last_name, s.admission_no,
       c.name AS class_name,
       fi.total_amount, fi.amount_paid, fi.balance, fi.status
     FROM fee_invoices fi
     JOIN students s ON s.id = fi.student_id
     JOIN users u ON u.id = s.user_id
     LEFT JOIN student_classes sc ON sc.student_id = fi.student_id
       AND sc.session_id = (SELECT session_id FROM terms WHERE id = fi.term_id)
     LEFT JOIN classes c ON c.id = sc.class_id
     WHERE fi.school_id = $1 AND fi.term_id = $2${conditions}
     ORDER BY u.last_name, u.first_name`,
    params
  );
  return result.rows;
}

export async function getInvoiceById(schoolId: string, invoiceId: string): Promise<FeeInvoiceRow | null> {
  const result = await pool.query<FeeInvoiceRow>(
    `SELECT id, school_id, student_id, term_id, total_amount, amount_paid, balance, status, created_at, updated_at
     FROM fee_invoices
     WHERE id = $1 AND school_id = $2`,
    [invoiceId, schoolId]
  );
  return result.rows[0] ?? null;
}

// ── Reporting ──────────────────────────────────────────────────────────────────

export interface OutstandingBalanceRow {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  class_name: string | null;
  total_amount: number;
  amount_paid: number;
  balance: number;
  status: 'unpaid' | 'partial' | 'paid';
}

export async function getOutstandingBalances(
  schoolId: string,
  termId: string,
  classId?: string | null
): Promise<OutstandingBalanceRow[]> {
  const params: unknown[] = [schoolId, termId];
  let classCondition = '';
  if (classId) {
    params.push(classId);
    classCondition = ` AND sc.class_id = $${params.length}`;
  }

  const result = await pool.query<OutstandingBalanceRow>(
    `SELECT
       fi.student_id, u.first_name, u.last_name, s.admission_no,
       c.name AS class_name,
       fi.total_amount, fi.amount_paid, fi.balance, fi.status
     FROM fee_invoices fi
     JOIN students s ON s.id = fi.student_id
     JOIN users u ON u.id = s.user_id
     LEFT JOIN student_classes sc ON sc.student_id = fi.student_id
       AND sc.session_id = (SELECT session_id FROM terms WHERE id = fi.term_id)
     LEFT JOIN classes c ON c.id = sc.class_id
     WHERE fi.school_id = $1 AND fi.term_id = $2 AND fi.balance > 0${classCondition}
     ORDER BY fi.balance DESC`,
    params
  );
  return result.rows;
}

export interface CollectionSummary {
  total_expected: number;
  total_collected: number;
  total_outstanding: number;
  counts: {
    unpaid: number;
    partial: number;
    paid: number;
  };
}

export async function getCollectionSummary(
  schoolId: string,
  termId: string,
  classId?: string | null
): Promise<CollectionSummary> {
  const params: unknown[] = [schoolId, termId];
  let classCondition = '';
  if (classId) {
    params.push(classId);
    classCondition = ` AND fi.student_id IN (SELECT student_id FROM student_classes WHERE class_id = $${params.length})`;
  }

  const result = await pool.query<{
    total_expected: string;
    total_collected: string;
    total_outstanding: string;
    unpaid: string;
    partial: string;
    paid: string;
  }>(
    `SELECT
       COALESCE(SUM(fi.total_amount), 0) AS total_expected,
       COALESCE(SUM(fi.amount_paid), 0) AS total_collected,
       COALESCE(SUM(fi.balance), 0) AS total_outstanding,
       COUNT(*) FILTER (WHERE fi.status = 'unpaid'::chronixedu_invoice_status)  AS unpaid,
       COUNT(*) FILTER (WHERE fi.status = 'partial'::chronixedu_invoice_status) AS partial,
       COUNT(*) FILTER (WHERE fi.status = 'paid'::chronixedu_invoice_status)    AS paid
     FROM fee_invoices fi
     WHERE fi.school_id = $1 AND fi.term_id = $2${classCondition}`,
    params
  );

  const row = result.rows[0];
  return {
    total_expected: Number(row.total_expected),
    total_collected: Number(row.total_collected),
    total_outstanding: Number(row.total_outstanding),
    counts: {
      unpaid: Number(row.unpaid),
      partial: Number(row.partial),
      paid: Number(row.paid),
    },
  };
}
