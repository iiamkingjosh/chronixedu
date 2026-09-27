/**
 * Receipt query regression.
 *
 * getPaymentById joined a table called `sessions`. The table is `academic_sessions`,
 * so every receipt download returned 500 (Postgres 42P01, undefined_table). It was
 * never caught because the fees unit tests mock `pg` entirely — a mocked driver will
 * happily "run" SQL naming a table that does not exist — and because no payment had
 * ever been recorded in production until the first live one.
 *
 * These tests run the real query against a schema built from /migrations, so a bad
 * table or column name fails here instead of in front of a parent.
 */
import { seed, IDS as I, pool } from './helpers';
import { getPaymentById, recordPayment } from '../db/queries/fees';
import { toKobo } from '../services/money';

beforeEach(seed);
afterAll(() => pool.end());

/** Creates an invoice for s1 and pays it, returning the payment id. */
async function payableInvoice(amount = 550): Promise<{ invoiceId: string; paymentId: string }> {
  const inv = await pool.query<{ id: string }>(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, $4, 0, $4, 'unpaid') RETURNING id`,
    [I.schoolA, I.s1, I.termA, amount]
  );
  const invoiceId = inv.rows[0].id;
  const result = await recordPayment(I.schoolA, invoiceId, {
    amountKobo: toKobo(amount),
    method: 'cash',
    reference: 'TEST-REF',
    paystack_reference: null,
    recorded_by: I.principalA,
  });
  if (!result) throw new Error('recordPayment returned null');
  return { invoiceId, paymentId: result.payment.id };
}

describe('settling an invoice to exactly zero', () => {
  it('accepts a parent paying their exact remaining balance', async () => {
    // The float guard computed 250000 - 83333.33 as 166666.66999999998 and refused
    // 166666.67 as an overpayment. A bursar keying the exact closing balance was told
    // it was too much.
    const inv = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 250000.00, 83333.33, 166666.67, 'partial') RETURNING id`,
      [I.schoolA, I.s1, I.termA]
    );

    const result = await recordPayment(I.schoolA, inv.rows[0].id, {
      amountKobo: 16666667, method: 'cash', reference: null, paystack_reference: null, recorded_by: I.principalA,
    });

    expect(result).not.toBeNull();
    expect(Number(result!.invoice.amount_paid)).toBe(250000);
    expect(Number(result!.invoice.balance)).toBe(0);
    expect(result!.invoice.status).toBe('paid');
  });

  it('settles to exactly zero across three uneven instalments', async () => {
    const inv = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 100000.00, 0, 100000.00, 'unpaid') RETURNING id`,
      [I.schoolA, I.s2, I.termA]
    );
    let last;
    // Distinct amounts on purpose: two identical cash payments within five minutes trip
    // the duplicate guard, which is intended behaviour and not what this test is about.
    // 33333.31 + 33333.33 + 33333.36 = 100000.00 exactly.
    for (const amount of [33333.31, 33333.33, 33333.36]) {
      last = await recordPayment(I.schoolA, inv.rows[0].id, {
        amountKobo: toKobo(amount), method: 'cash', reference: null, paystack_reference: null, recorded_by: I.principalA,
      });
    }
    expect(Number(last!.invoice.balance)).toBe(0);
    expect(last!.invoice.status).toBe('paid');
  });

  it('still refuses a genuine overpayment by one kobo', async () => {
    const inv = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 250000.00, 83333.33, 166666.67, 'partial') RETURNING id`,
      [I.schoolA, I.s3OtherClass, I.termA]
    );
    await expect(recordPayment(I.schoolA, inv.rows[0].id, {
      amountKobo: 16666668, method: 'cash', reference: null, paystack_reference: null, recorded_by: I.principalA,
    })).rejects.toThrow();
  });
});

describe('getPaymentById (receipt data)', () => {
  it('resolves a payment with student, class, term and session names', async () => {
    const { paymentId } = await payableInvoice();

    const row = await getPaymentById(I.schoolA, paymentId);

    expect(row).not.toBeNull();
    expect(row!.admission_no).toBe('ADM-1');
    expect(row!.term_name).toBe('First Term');
    expect(row!.session_name).toBe('2026/2027');
    expect(row!.class_name).toBe('JSS 2A');
    expect(Number(row!.amount)).toBe(550);
  });

  it('is scoped to the school — another school cannot read the payment', async () => {
    const { paymentId } = await payableInvoice();
    expect(await getPaymentById(I.schoolB, paymentId)).toBeNull();
  });

  it('returns null for an unknown payment id rather than throwing', async () => {
    expect(await getPaymentById(I.schoolA, I.sOtherSchool)).toBeNull();
  });

  it('still resolves when the student has no class enrolment for the term', async () => {
    // class_name comes from a LEFT JOIN — a student with no enrolment must not make
    // the whole receipt query drop the row.
    const inv = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 100, 0, 100, 'unpaid') RETURNING id`,
      [I.schoolA, I.s3OtherClass, I.termA]
    );
    await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [I.s3OtherClass]);

    const paid = await recordPayment(I.schoolA, inv.rows[0].id, {
      amountKobo: 10000, method: 'cash', reference: null, paystack_reference: null, recorded_by: I.principalA,
    });
    const row = await getPaymentById(I.schoolA, paid!.payment.id);

    expect(row).not.toBeNull();
    expect(row!.class_name).toBeNull();
    expect(row!.session_name).toBe('2026/2027');
  });
});
