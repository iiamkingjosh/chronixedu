/**
 * An online fee payment is credited only through the record its start wrote before Paystack was called
 * (migration 062; SECURITY.md Round 38). Paystack's metadata, and the school in the address a webhook or
 * the return page arrived at, never decide where a payment goes. Tested against the real routes and
 * database; Paystack's API is stood in for at the service boundary, and the signature check is real.
 *
 * The reviewer's mirror of platformBillingFullStack.test.ts: a payment whose metadata names the wrong
 * school and invoice is still credited to the right ones, by its reference.
 */
process.env.PAYSTACK_SECRET_KEY = 'sk_test_db_suite_only';

const mockVerify = jest.fn();
const mockInitialize = jest.fn();
jest.mock('../services/paystackService', () => ({
  ...jest.requireActual('../services/paystackService'),
  isPaystackConfigured: () => true,
  verifyPaystackTransaction: (ref: string) => mockVerify(ref),
  initializePaystackTransaction: (input: unknown) => mockInitialize(input),
}));
jest.mock('../services/paymentReceiptNotifier', () => ({ notifyPaymentReceipt: jest.fn() }));

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { pool, seed, IDS as I, buildApp, tokens } from './helpers';
import feesPublicRoutes from '../routes/feesPublic';
import { errorHandler } from '../middleware/errorHandler';
import { createFeeCheckout } from '../db/queries/feeCheckouts';
import { logger } from '../config/logger';

const A = I.schoolA;
const B = I.schoolB;
const CALLER_IP = '102.89.44.217';

function publicApp() {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));
  a.use('/api/schools', feesPublicRoutes);
  a.use(errorHandler);
  return a;
}
const app = publicApp();
const schoolsApp = buildApp();

function deliver(body: object, school = A) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex');
  return request(app).post(`/api/schools/${school}/payments/paystack/webhook`)
    .set('x-paystack-signature', sig).set('Content-Type', 'application/json').send(raw);
}
const charge = (reference: string) => ({ event: 'charge.success', data: { reference } });

let invoiceA: string;
let invoiceB: string;
const paid = async (invoiceId: string) => (await pool.query(`SELECT amount_paid FROM fee_invoices WHERE id = $1`, [invoiceId])).rows[0].amount_paid;
const payments = async () => (await pool.query(`SELECT school_id, invoice_id, amount, paystack_reference FROM payments ORDER BY created_at`)).rows;
const checkout = async (ref: string) => (await pool.query(`SELECT status, failure_reason, payment_id FROM fee_checkouts WHERE reference = $1`, [ref])).rows[0];

/** A payment started the normal way, and Paystack's verify for it, with whatever metadata is given. */
async function started(reference: string, kobo: number, metadata: Record<string, unknown> = { school_id: A, invoice_id: invoiceA }) {
  await createFeeCheckout({ reference, schoolId: A, invoiceId: invoiceA, feeKobo: kobo, convenienceFeeKobo: 0, initiatedBy: I.parentA });
  mockVerify.mockResolvedValue({ status: 'success', amountKobo: kobo, currency: 'NGN', reference, metadata });
}

beforeEach(async () => {
  await seed();
  invoiceA = (await pool.query(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, 100000.00, 0, 100000.00, 'unpaid') RETURNING id`, [A, I.s1, I.termA])).rows[0].id;
  invoiceB = (await pool.query(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, 100000.00, 0, 100000.00, 'unpaid') RETURNING id`, [B, I.sOtherSchool, I.termB])).rows[0].id;
  jest.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe('starting a payment writes its record before Paystack is called', () => {
  beforeEach(async () => {
    await pool.query(
      `UPDATE schools SET payout_config = jsonb_build_object('settlement_status', 'active', 'paystack_subaccount_code', 'ACCT_test') WHERE id = $1`, [A]);
  });

  it('the record exists, with the school, invoice and amount, when Paystack is asked', async () => {
    let recordAtCall: unknown;
    mockInitialize.mockImplementation(async (input: { reference: string }) => {
      recordAtCall = (await pool.query(`SELECT school_id, invoice_id, fee_kobo, convenience_fee_kobo, initiated_by, status FROM fee_checkouts WHERE reference = $1`, [input.reference])).rows[0];
      return { authorization_url: 'https://checkout.paystack.test/x', access_code: 'x', reference: input.reference };
    });
    const res = await request(schoolsApp).post(`/api/schools/${A}/payments/paystack/initiate`)
      .set('Authorization', tokens.parentA()).send({ invoice_id: invoiceA, amount: '30000' });
    expect(res.status).toBe(200);
    expect(recordAtCall).toEqual({ school_id: A, invoice_id: invoiceA, fee_kobo: '3000000', convenience_fee_kobo: '0', initiated_by: I.parentA, status: 'pending' });
    expect(mockInitialize).toHaveBeenCalledWith(expect.objectContaining({ amountKobo: 3_000_000, bearer: 'subaccount' }));
  });

  it('when Paystack will not open the payment, the record is marked failed', async () => {
    mockInitialize.mockResolvedValue(null);
    const res = await request(schoolsApp).post(`/api/schools/${A}/payments/paystack/initiate`)
      .set('Authorization', tokens.parentA()).send({ invoice_id: invoiceA, amount: '30000' });
    expect(res.status).toBe(502);
    expect((await pool.query(`SELECT status, failure_reason FROM fee_checkouts`)).rows).toEqual([{ status: 'failed', failure_reason: 'paystack_init_failed' }]);
  });
});

describe('the webhook credits through the record, never the metadata or the address', () => {
  it('metadata naming another school and invoice still credits the record\'s school and invoice (the mirror test)', async () => {
    await started('ref-1', 2_500_000, { school_id: B, invoice_id: invoiceB, recorded_by: I.principalB });
    const res = await deliver(charge('ref-1'));
    expect(res.body.data).toEqual({ processed: true });
    expect(await payments()).toEqual([{ school_id: A, invoice_id: invoiceA, amount: '25000.00', paystack_reference: 'ref-1' }]);
    expect(await paid(invoiceA)).toBe('25000.00');
    expect(await paid(invoiceB)).toBe('0.00');
    expect(await checkout('ref-1')).toMatchObject({ status: 'consumed', failure_reason: null });
  });

  it('arriving at another school\'s address changes nothing about where it goes', async () => {
    await started('ref-2', 1_000_000);
    expect((await deliver(charge('ref-2'), B)).body.data).toEqual({ processed: true });
    expect(await payments()).toMatchObject([{ school_id: A, invoice_id: invoiceA }]);
  });

  it('a payment no record started is not credited, and alerts', async () => {
    mockVerify.mockResolvedValue({ status: 'success', amountKobo: 1_000_000, currency: 'NGN', reference: 'ref-x', metadata: { school_id: A, invoice_id: invoiceA } });
    const error = jest.spyOn(logger, 'error');
    const res = await deliver(charge('ref-x'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ processed: false, reason: 'no_checkout' });
    expect(await payments()).toEqual([]);
    expect(error).toHaveBeenCalledWith('paystack_fee_payment_unmatched', { route: 'fees_webhook', paystack_reference: 'ref-x' });
    error.mockRestore();
  });

  it('a verified amount other than the record\'s is not credited, fails the record, and alerts', async () => {
    await started('ref-3', 1_000_000);
    mockVerify.mockResolvedValue({ status: 'success', amountKobo: 999_999, currency: 'NGN', reference: 'ref-3' });
    const error = jest.spyOn(logger, 'error');
    await deliver(charge('ref-3'));
    expect(await payments()).toEqual([]);
    expect(await checkout('ref-3')).toMatchObject({ status: 'failed', failure_reason: 'amount_mismatch' });
    expect(error).toHaveBeenCalledWith('paystack_fee_amount_mismatch', expect.objectContaining({ expected_kobo: 1_000_000, verified_kobo: 999_999 }));
    error.mockRestore();
  });

  it('another currency is not credited, and the alert says which currency arrived', async () => {
    await started('ref-4', 1_000_000);
    mockVerify.mockResolvedValue({ status: 'success', amountKobo: 1_000_000, currency: 'USD', reference: 'ref-4' });
    const error = jest.spyOn(logger, 'error');
    await deliver(charge('ref-4'));
    expect(await payments()).toEqual([]);
    expect(await checkout('ref-4')).toMatchObject({ status: 'failed', failure_reason: 'not_naira' });
    // payment_not_naira carries the currency (config/alerts.ts): it is what has to be refunded.
    expect(error).toHaveBeenCalledWith('paystack_payment_not_naira', expect.objectContaining({ route: 'fees_webhook', currency: 'USD' }));
    error.mockRestore();
  });

  it('delivered again, and twice at the same moment, it is credited once', async () => {
    await started('ref-5', 1_000_000);
    const results = await Promise.all([deliver(charge('ref-5')), deliver(charge('ref-5'))]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect((await deliver(charge('ref-5'))).body.data).toMatchObject({ duplicate: true });
    expect(await payments()).toHaveLength(1);
    expect(await paid(invoiceA)).toBe('10000.00');
  });

  it("Chronix's own subscription payment arriving here is settled by its reference", async () => {
    const sub = (await pool.query(
      `INSERT INTO platform_subscriptions (school_id, plan, subscription_status) VALUES ($1, 'trial', 'trial') RETURNING id`, [A])).rows[0].id;
    await pool.query(
      `INSERT INTO platform_subscription_payments (school_id, subscription_id, reference, amount_kobo, plan, billing_cycle, status, initiated_by)
       VALUES ($1, $2, 'chronix-ref', 80000, 'premium', 'termly', 'pending', $3)`, [A, sub, I.principalA]);
    mockVerify.mockResolvedValue({ status: 'success', amountKobo: 80000, currency: 'NGN', reference: 'chronix-ref' });
    const res = await deliver(charge('chronix-ref'));
    expect(res.body.data).toEqual({ processed: true, outcome: 'settled' });
    expect((await pool.query(`SELECT status FROM platform_subscription_payments WHERE reference = 'chronix-ref'`)).rows[0].status).toBe('consumed');
    expect(await payments()).toEqual([]);
  });

  it('any other event is acknowledged and logged by name, not dropped silently', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const res = await deliver({ event: 'charge.dispute.create', data: { id: 1 } });
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith('paystack_event_unhandled', { event: 'charge.dispute.create' });
    warn.mockRestore();
  });
});

describe('the return page credits the same way', () => {
  const back = (ref: string, school = A) =>
    request(app).get(`/api/schools/${school}/payments/paystack/callback?reference=${ref}`).set('X-Real-IP', CALLER_IP);

  it('the school in its address and the metadata are ignored; the record decides, and the payer\'s address is audited', async () => {
    await started('ref-c1', 2_000_000, { school_id: B, invoice_id: invoiceB });
    const res = await back('ref-c1', B);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/parent\/fees\?payment=success$/);
    expect(await payments()).toMatchObject([{ school_id: A, invoice_id: invoiceA, amount: '20000.00' }]);
    expect((await pool.query(`SELECT user_id, ip_address FROM audit_logs WHERE action_type = 'PAYMENT_RECORDED'`)).rows)
      .toEqual([{ user_id: I.parentA, ip_address: CALLER_IP }]);
  });

  it('a payment no record started is refused with a reason, and alerts', async () => {
    mockVerify.mockResolvedValue({ status: 'success', amountKobo: 1_000_000, currency: 'NGN', reference: 'ref-c2', metadata: { school_id: A, invoice_id: invoiceA } });
    const error = jest.spyOn(logger, 'error');
    const res = await back('ref-c2');
    expect(res.headers.location).toMatch(/payment=error&reason=unknown_payment$/);
    expect(await payments()).toEqual([]);
    expect(error).toHaveBeenCalledWith('paystack_fee_payment_unmatched', { route: 'fees_callback', paystack_reference: 'ref-c2' });
    error.mockRestore();
  });
});
