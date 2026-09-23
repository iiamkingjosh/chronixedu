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
    amount,
    method: 'cash',
    reference: 'TEST-REF',
    paystack_reference: null,
    recorded_by: I.principalA,
  });
  if (!result) throw new Error('recordPayment returned null');
  return { invoiceId, paymentId: result.payment.id };
}

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
      amount: 100, method: 'cash', reference: null, paystack_reference: null, recorded_by: I.principalA,
    });
    const row = await getPaymentById(I.schoolA, paid!.payment.id);

    expect(row).not.toBeNull();
    expect(row!.class_name).toBeNull();
    expect(row!.session_name).toBe('2026/2027');
  });
});
