/**
 * Refunds recorded by the bursar (migration 063; decided 5-6 Oct 2026). Schools pay refunds back from
 * their own money, by cash or bank transfer, for every payment that moved money, online ones included.
 * A refund is a record of its own; the payment is never edited; the invoice is recomputed. Tested against
 * the real routes and database. Every refusal is shown beside a request that succeeds (doctrine 16).
 */
import request from 'supertest';
import { pool, seed, IDS as I, buildApp, token } from './helpers';
import { recordPayment, getPaymentById, getInvoiceByStudent } from '../db/queries/fees';

const A = I.schoolA;
const BURSAR = 'b0a50000-0000-4000-8000-000000000001';
const CALLER_IP = '102.89.44.217';
const app = buildApp();
const bursar = () => token(BURSAR, 'bursar', A);

let invoiceId: string;

const refundBy = (paymentId: string, body: object, t = bursar()) =>
  request(app).post(`/api/schools/${A}/payments/${paymentId}/refunds`).set('Authorization', t).set('X-Real-IP', CALLER_IP).send(body);
const refunds = async () => (await pool.query(`SELECT * FROM fee_refunds ORDER BY created_at`)).rows;
const invoice = async () => (await pool.query(`SELECT amount_paid, balance, status FROM fee_invoices WHERE id = $1`, [invoiceId])).rows[0];

/** Resolves once `n` other sessions are waiting on a row lock: a condition read from Postgres, not a sleep. */
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (rows[0].waiting >= n) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`fewer than ${n} sessions ever waited on the lock`);
}

async function pay(method: 'cash' | 'bank_transfer' | 'paystack' | 'waiver', kobo: number, ref?: string) {
  const r = await recordPayment(A, invoiceId, {
    amountKobo: kobo, method, reference: null, paystack_reference: method === 'paystack' ? (ref ?? `ref-${kobo}`) : null, recorded_by: BURSAR,
  });
  return r!.payment;
}

beforeEach(async () => {
  await seed();
  invoiceId = (await pool.query(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, 100000.00, 0, 100000.00, 'unpaid') RETURNING id`, [A, I.s1, I.termA])).rows[0].id;
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
     VALUES ($1, $2, 'bursar-a@test', 'x', 'bursar', 'Bursar', 'A', true, false)`, [BURSAR, A]);
});

afterAll(async () => {
  await pool.end();
});

describe('recording a refund', () => {
  it('a cash refund is recorded beside the payment, the invoice follows, and who and from where is audited', async () => {
    const p = await pay('cash', 3_000_000);
    const res = await refundBy(p.id, { amount: '1000.50', method: 'cash', reason: 'overpaid' });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({ amount_paid: '28999.50', balance: '71000.50', status: 'partial' });
    expect(await refunds()).toMatchObject([{ amount_kobo: '100050', method: 'cash', reason: 'overpaid', reference: null, note: null, recorded_by: BURSAR }]);
    expect((await pool.query(`SELECT amount FROM payments WHERE id = $1`, [p.id])).rows[0].amount).toBe('30000.00');
    expect((await pool.query(`SELECT user_id, ip_address, new_value FROM audit_logs WHERE action_type = 'REFUND_RECORDED'`)).rows)
      .toMatchObject([{ user_id: BURSAR, ip_address: CALLER_IP, new_value: { reason: 'overpaid', method: 'cash' } }]);
    // What the receipt and the invoice view read.
    expect((await getPaymentById(A, p.id))?.refunded_kobo).toBe('100050');
    expect((await getInvoiceByStudent(A, I.s1, I.termA))?.payments.map(x => x.refunded_kobo)).toEqual(['100050']);
  });

  it('an online payment is refunded by hand too, by transfer, with or without a reference', async () => {
    const online = await pay('paystack', 5_000_000);
    expect((await refundBy(online.id, { amount: '20000', method: 'bank_transfer', reason: 'paid_twice', reference: 'TRF-123' })).status).toBe(201);
    expect((await refundBy(online.id, { amount: '5000', method: 'bank_transfer', reason: 'paid_twice' })).status).toBe(201);
    expect((await refunds()).map(r => [r.amount_kobo, r.reference])).toEqual([['2000000', 'TRF-123'], ['500000', null]]);
    expect(await invoice()).toMatchObject({ amount_paid: '25000.00', status: 'partial' });
  });

  it('a full refund turns the invoice back to unpaid', async () => {
    const p = await pay('cash', 4_000_000);
    await refundBy(p.id, { amount: '40000', method: 'cash', reason: 'withdrew' });
    expect(await invoice()).toEqual({ amount_paid: '0.00', balance: '100000.00', status: 'unpaid' });
  });
});

describe('what is refused', () => {
  it('the principal: refunds are the bursar\'s', async () => {
    const p = await pay('cash', 1_000_000);
    expect((await refundBy(p.id, { amount: '100', method: 'cash', reason: 'overpaid' }, token(I.principalA, 'principal', A))).status).toBe(403);
    expect(await refunds()).toEqual([]);
  });

  it('a waiver: it moved no money', async () => {
    const waiver = await pay('waiver', 500_000);
    const res = await refundBy(waiver.id, { amount: '100', method: 'cash', reason: 'overpaid' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WAIVER_NOT_REFUNDABLE');
    expect(await refunds()).toEqual([]);
  });

  it('more than is left of the payment, saying how much is', async () => {
    const p = await pay('cash', 1_000_000);
    expect((await refundBy(p.id, { amount: '6000', method: 'cash', reason: 'overpaid' })).status).toBe(201);
    const res = await refundBy(p.id, { amount: '4000.01', method: 'bank_transfer', reason: 'overpaid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'REFUND_EXCEEDS_PAYMENT', message: 'At most ₦4,000.00 of this payment can still be refunded.' });
    expect((await refundBy(p.id, { amount: '4000', method: 'bank_transfer', reason: 'overpaid' })).status).toBe(201);
  });

  it('two refunds of the whole payment at the same moment: one is recorded, the other refused', async () => {
    const p = await pay('cash', 1_000_000);
    // Made to overlap, not hoped to (doctrine 15): sent one after the other, the two never met, and this
    // test passed with the invoice lock removed. A third connection holds the invoice row until both
    // refunds are waiting on a lock, so each has started before either can finish.
    const holder = await pool.connect();
    let both: request.Response[];
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM fee_invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
      const sent = Promise.all([
        refundBy(p.id, { amount: '10000', method: 'cash', reason: 'paid_twice' }),
        refundBy(p.id, { amount: '10000', method: 'cash', reason: 'paid_twice' }),
      ]);
      await waitForLockWaiters(2);
      await holder.query('COMMIT');
      both = await sent;
    } finally {
      holder.release();
    }
    expect(both.map(r => r.status).sort()).toEqual([201, 400]);
    expect(await refunds()).toHaveLength(1);
    expect(await invoice()).toMatchObject({ amount_paid: '0.00' });
  });

  it('no reason, an unknown one, or Other without saying what', async () => {
    const p = await pay('cash', 1_000_000);
    for (const body of [
      { amount: '100', method: 'cash' },
      { amount: '100', method: 'cash', reason: 'felt_like_it' },
      { amount: '100', method: 'cash', reason: 'other' },
    ]) {
      expect({ body, status: (await refundBy(p.id, body)).status }).toEqual({ body, status: 400 });
    }
    expect((await refundBy(p.id, { amount: '100', method: 'cash', reason: 'other', note: 'Fee reduced by the school' })).status).toBe(201);
    expect(await refunds()).toHaveLength(1);
  });

  it('another school\'s payment', async () => {
    const p = await pay('cash', 1_000_000);
    const res = await request(app).post(`/api/schools/${I.schoolB}/payments/${p.id}/refunds`)
      .set('Authorization', bursar()).send({ amount: '100', method: 'cash', reason: 'overpaid' });
    expect(res.status).toBe(403);
    expect(await refunds()).toEqual([]);
  });
});

describe('the table holds its own shape', () => {
  it('a reason from the list, and Other only with a note', async () => {
    const p = await pay('cash', 1_000_000);
    const insert = (reason: string, note: string | null) => pool.query(
      `INSERT INTO fee_refunds (school_id, payment_id, invoice_id, amount_kobo, method, reason, note, recorded_by)
       VALUES ($1, $2, $3, 100, 'cash', $4, $5, $6)`, [A, p.id, invoiceId, reason, note, BURSAR]);
    await expect(insert('other', null)).rejects.toThrow(/fee_refunds_other_has_note/);
    await expect(insert('because', null)).rejects.toThrow(/fee_refunds_reason_check/);
    await expect(insert('overpaid', null)).resolves.toMatchObject({ rowCount: 1 });
  });
});
