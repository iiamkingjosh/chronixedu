/**
 * The minimum part payment, and the case it must never refuse.
 *
 * Parents can pay part of a term's fees online. `bearer: 'subaccount'` means the SCHOOL
 * pays the Paystack fee on every attempt, so an unbounded floor is a margin leak — twenty
 * ₦500 payments against a ₦10,000 balance cost more in fees than one payment would.
 *
 * The first describe block is the important one. A minimum that also applies to a payment
 * CLEARING the balance refuses a parent paying exactly what they owe — a balance of ₦600
 * against a ₦1,000 minimum becomes unsettleable online. That is the same defect as
 * fe222d2 (float subtraction in the overpayment guard), rebuilt in a new guard with
 * different arithmetic: same counter, same parent, same refusal. It is written first
 * because it looks like a corner case and is not.
 */
import request from 'supertest';
import { buildApp, seed, IDS as I, tokens, pool } from './helpers';
import { DEFAULT_MIN_PART_PAYMENT_KOBO } from '../db/queries/schools';
import { fromKobo } from '../services/money';

const app = buildApp();

beforeEach(seed);
afterAll(() => pool.end());

/** An invoice for s1 with the given naira total, wholly unpaid. */
async function invoice(total: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, $4, 0, $4, 'unpaid') RETURNING id`,
    [I.schoolA, I.s1, I.termA, total]
  );
  return rows[0].id;
}

/** Payout must be active or the route short-circuits before the minimum is reached. */
async function enablePayout(): Promise<void> {
  await pool.query(
    `UPDATE schools SET payout_config = $2::jsonb WHERE id = $1`,
    [I.schoolA, JSON.stringify({ settlement_status: 'active', paystack_subaccount_code: 'ACCT_test' })]
  );
}

async function setMinimum(naira: string): Promise<void> {
  await pool.query(
    `INSERT INTO school_settings (school_id, identity_config, academic_config, fee_config)
     VALUES ($1, '{}'::jsonb, '{}'::jsonb, $2::jsonb)
     ON CONFLICT (school_id) DO UPDATE SET fee_config = EXCLUDED.fee_config`,
    [I.schoolA, JSON.stringify({ min_part_payment_kobo: Math.round(Number(naira) * 100) })]
  );
}

/** Parents initiate their own payments; s1's parent is parentA in the fixture. */
function initiate(invoiceId: string, amount?: string) {
  const body: Record<string, unknown> = { invoice_id: invoiceId };
  if (amount !== undefined) body.amount = amount;
  return request(app)
    .post(`/api/schools/${I.schoolA}/payments/paystack/initiate`)
    .set('Authorization', tokens.parentA())
    .send(body);
}

describe('clearing the balance is always allowed, whatever the minimum says', () => {
  it('accepts a payment for the exact balance when the balance is BELOW the minimum', async () => {
    // ₦600 owed, ₦1,000 minimum. Refusing this makes the invoice unsettleable online.
    await enablePayout();
    await setMinimum('1000.00');
    const id = await invoice('600.00');

    const res = await initiate(id, '600.00');
    expect(res.body.error?.code).not.toBe('BELOW_MIN_PART_PAYMENT');
  });

  it('accepts an omitted amount when the balance is below the minimum', async () => {
    // Omitting amount means "the whole balance", which is the same case by another route.
    await enablePayout();
    await setMinimum('1000.00');
    const id = await invoice('600.00');

    const res = await initiate(id);
    expect(res.body.error?.code).not.toBe('BELOW_MIN_PART_PAYMENT');
  });

  it('still refuses a PART payment below the minimum on the same invoice', async () => {
    // The carve-out must be exactly "clears the balance", not "small invoice".
    await enablePayout();
    await setMinimum('1000.00');
    const id = await invoice('5000.00');

    const res = await initiate(id, '600.00');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BELOW_MIN_PART_PAYMENT');
  });
});

describe('the minimum part payment', () => {
  it('refuses a part payment below the school-configured minimum', async () => {
    await enablePayout();
    await setMinimum('2000.00');
    const id = await invoice('50000.00');

    const res = await initiate(id, '500.00');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BELOW_MIN_PART_PAYMENT');
    expect(res.body.error.details.min_part_payment).toBe('2000.00');
    expect(res.body.error.details.balance).toBe('50000.00');
  });

  it('accepts a part payment exactly at the minimum', async () => {
    await enablePayout();
    await setMinimum('2000.00');
    const id = await invoice('50000.00');

    const res = await initiate(id, '2000.00');
    expect(res.body.error?.code).not.toBe('BELOW_MIN_PART_PAYMENT');
  });

  it('applies the Chronix default when the school has set no minimum', async () => {
    // Unset must not mean "no minimum": the failure direction is the school paying a
    // Paystack fee on a ₦1 payment.
    await enablePayout();
    const id = await invoice('50000.00');

    const res = await initiate(id, '1.00');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BELOW_MIN_PART_PAYMENT');
    expect(res.body.error.details.min_part_payment).toBe(fromKobo(DEFAULT_MIN_PART_PAYMENT_KOBO));
  });

  it('applies the default when the school row exists but fee_config is empty', async () => {
    await enablePayout();
    await pool.query(
      `INSERT INTO school_settings (school_id, identity_config, academic_config)
       VALUES ($1, '{}'::jsonb, '{}'::jsonb) ON CONFLICT (school_id) DO NOTHING`,
      [I.schoolA]
    );
    const id = await invoice('50000.00');

    const res = await initiate(id, '1.00');
    expect(res.body.error.code).toBe('BELOW_MIN_PART_PAYMENT');
  });

  it('tells the parent both the minimum and the balance, so the message is actionable', async () => {
    await enablePayout();
    await setMinimum('2000.00');
    const id = await invoice('50000.00');

    const res = await initiate(id, '500.00');
    expect(res.body.error.message).toContain('2000.00');
    expect(res.body.error.message).toContain('50000.00');
  });
});

describe('the existing guards still hold', () => {
  it('refuses more than the outstanding balance', async () => {
    await enablePayout();
    const id = await invoice('5000.00');
    const res = await initiate(id, '5000.01');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  });

  it('rejects a third decimal place rather than rounding it', async () => {
    await enablePayout();
    const id = await invoice('5000.00');
    const res = await initiate(id, '1000.005');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses an already settled invoice', async () => {
    await enablePayout();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 5000.00, 5000.00, 0, 'paid') RETURNING id`,
      [I.schoolA, I.s1, I.termA]
    );
    const res = await initiate(rows[0].id, '1000.00');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVOICE_ALREADY_SETTLED');
  });
});
