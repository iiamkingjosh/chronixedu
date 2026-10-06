/**
 * The convenience fee (6 Oct 2026; built before Paystack answered, to be corrected after). A school chooses
 * who pays Paystack's charge on a parent's online payment. Unchosen, the school does, as before. When parents
 * do, a convenience fee is added so the school receives its whole fee: the parent sees it before paying,
 * Paystack is asked for the total, the record states both parts, the invoice is credited the school fee
 * only, by every path that credits an online payment, and a refund can never return the convenience fee.
 * Tested against the real routes and database; Paystack's API is stood in for at the service boundary.
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
import { pool, seed, IDS as I, buildApp, tokens, token } from './helpers';
import feesPublicRoutes from '../routes/feesPublic';
import { errorHandler } from '../middleware/errorHandler';
import { getPaymentById } from '../db/queries/fees';
import { logger } from '../config/logger';

const A = I.schoolA;
const BURSAR = 'b0a50000-0000-4000-8000-000000000002';
const CALLER_IP = '102.89.44.217';
const app = buildApp();
const bursar = () => token(BURSAR, 'bursar', A);

const publicApp = (() => {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));
  a.use('/api/schools', feesPublicRoutes);
  a.use(errorHandler);
  return a;
})();

function deliver(reference: string) {
  const raw = JSON.stringify({ event: 'charge.success', data: { reference } });
  const sig = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex');
  return request(publicApp).post(`/api/schools/${A}/payments/paystack/webhook`)
    .set('x-paystack-signature', sig).set('Content-Type', 'application/json').send(raw);
}

let invoiceId: string;
const choose = (payer: unknown) => request(app).patch(`/api/schools/${A}/fee-config`)
  .set('Authorization', tokens.principalA()).set('X-Real-IP', CALLER_IP).send({ convenience_fee_payer: payer });
const feeConfig = async () => (await request(app).get(`/api/schools/${A}/fee-config`).set('Authorization', tokens.principalA())).body.data;
const startPayment = (amount: string) => request(app).post(`/api/schools/${A}/payments/paystack/initiate`)
  .set('Authorization', tokens.parentA()).send({ invoice_id: invoiceId, amount });
const checkouts = async () => (await pool.query(
  `SELECT reference, fee_kobo, convenience_fee_kobo, status FROM fee_checkouts ORDER BY created_at`)).rows;
const invoice = async () => (await pool.query(`SELECT amount_paid, balance, status FROM fee_invoices WHERE id = $1`, [invoiceId])).rows[0];
const payments = async () => (await pool.query(`SELECT id, amount, method, paystack_reference, recorded_by FROM payments ORDER BY created_at`)).rows;

/** Starts a ₦30,000 payment and has Paystack verify it at `verifiedKobo` (the total it was asked for, unless given). */
async function startAndVerify(verifiedKobo?: number) {
  const res = await startPayment('30000');
  expect(res.status).toBe(200);
  const { reference, amountKobo } = mockInitialize.mock.calls.at(-1)![0] as { reference: string; amountKobo: number };
  mockVerify.mockResolvedValue({ status: 'success', amountKobo: verifiedKobo ?? amountKobo, currency: 'NGN', reference, metadata: {} });
  return { reference, totalKobo: amountKobo };
}

beforeEach(async () => {
  await seed();
  invoiceId = (await pool.query(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, 100000.00, 0, 100000.00, 'unpaid') RETURNING id`, [A, I.s1, I.termA])).rows[0].id;
  await pool.query(
    `UPDATE schools SET payout_config = jsonb_build_object('settlement_status', 'active', 'paystack_subaccount_code', 'ACCT_test') WHERE id = $1`, [A]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
     VALUES ($1, $2, 'bursar-cf@test', 'x', 'bursar', 'Bursar', 'A', true, false)`, [BURSAR, A]);
  jest.clearAllMocks();
  mockInitialize.mockImplementation(async (input: { reference: string }) =>
    ({ authorization_url: 'https://checkout.paystack.test/x', access_code: 'x', reference: input.reference }));
});

afterAll(async () => {
  await pool.end();
});

describe('the setting', () => {
  it('starts unchosen, and each choice is audited with the one before it', async () => {
    expect(await feeConfig()).toMatchObject({
      convenience_fee_payer: null,
      convenience_fee_example: { school_fee: '50000.00', convenience_fee: '862.95', total: '50862.95' },
    });
    expect((await choose('parent')).status).toBe(200);
    expect((await choose('school')).status).toBe(200);
    expect((await feeConfig()).convenience_fee_payer).toBe('school');
    const audit = (await pool.query(
      `SELECT old_value, new_value, ip_address FROM audit_logs WHERE action_type = 'SETTINGS_CHANGE' ORDER BY created_at`)).rows;
    expect(audit).toEqual([
      { old_value: { field: 'convenience_fee_payer', value: { convenience_fee_payer: null } },
        new_value: { field: 'convenience_fee_payer', value: { convenience_fee_payer: 'parent' } }, ip_address: CALLER_IP },
      { old_value: { field: 'convenience_fee_payer', value: { convenience_fee_payer: 'parent' } },
        new_value: { field: 'convenience_fee_payer', value: { convenience_fee_payer: 'school' } }, ip_address: CALLER_IP },
    ]);
  });

  it('refuses a payer that is neither, an empty save, and a teacher', async () => {
    expect((await choose('parent')).status).toBe(200);
    expect((await choose('chronix')).status).toBe(400);
    expect((await request(app).patch(`/api/schools/${A}/fee-config`).set('Authorization', tokens.principalA()).send({})).status).toBe(400);
    expect((await request(app).patch(`/api/schools/${A}/fee-config`).set('Authorization', tokens.math()).send({ convenience_fee_payer: 'school' })).status).toBe(403);
    expect((await feeConfig()).convenience_fee_payer).toBe('parent');
  });

  it('a stored value that is neither, by hand, reads as unchosen: the parent is charged nothing extra', async () => {
    await pool.query(
      `INSERT INTO school_settings (school_id, fee_config) VALUES ($1, '{"convenience_fee_payer": "Parent"}')
       ON CONFLICT (school_id) DO UPDATE SET fee_config = EXCLUDED.fee_config`, [A]);
    expect((await feeConfig()).convenience_fee_payer).toBeNull();
    await startPayment('30000');
    expect(mockInitialize).toHaveBeenCalledWith(expect.objectContaining({ amountKobo: 3_000_000 }));
  });
});

describe('starting a payment', () => {
  it('unchosen: Paystack is asked for the school fee alone, and the record says the convenience fee is nought', async () => {
    const res = await startPayment('30000');
    expect(res.body.data).toMatchObject({ school_fee: '30000.00', convenience_fee: '0.00', total: '30000.00' });
    expect(mockInitialize).toHaveBeenCalledWith(expect.objectContaining({ amountKobo: 3_000_000, bearer: 'subaccount' }));
    expect(await checkouts()).toMatchObject([{ fee_kobo: '3000000', convenience_fee_kobo: '0' }]);
  });

  it('parents pay: Paystack is asked for the total, and the record and the response state both parts', async () => {
    await choose('parent');
    const res = await startPayment('30000');
    // ₦30,000 + 1.5% + ₦100, grossed up: 3,055,838 kobo, of which Paystack keeps 55,838.
    expect(res.body.data).toMatchObject({
      authorization_url: 'https://checkout.paystack.test/x', school_fee: '30000.00', convenience_fee: '558.38', total: '30558.38',
    });
    expect(mockInitialize).toHaveBeenCalledWith(expect.objectContaining({ amountKobo: 3_055_838, bearer: 'subaccount' }));
    expect(await checkouts()).toMatchObject([{ fee_kobo: '3000000', convenience_fee_kobo: '55838', status: 'pending' }]);
  });

  it('the school pays, chosen: the same as unchosen', async () => {
    await choose('school');
    await startPayment('30000');
    expect(mockInitialize).toHaveBeenCalledWith(expect.objectContaining({ amountKobo: 3_000_000 }));
  });
});

describe('crediting a payment with a convenience fee: the school fee only, by every path', () => {
  beforeEach(async () => { await choose('parent'); });

  it('the webhook credits the school fee, and the receipt shows the convenience fee beside it', async () => {
    const { reference } = await startAndVerify();
    expect((await deliver(reference)).body.data).toEqual({ processed: true });
    expect(await invoice()).toMatchObject({ amount_paid: '30000.00', balance: '70000.00' });
    const [p] = await payments();
    expect(p).toMatchObject({ amount: '30000.00', method: 'paystack', paystack_reference: reference });
    expect(await getPaymentById(A, p.id)).toMatchObject({ amount: '30000.00', convenience_fee_kobo: '55838' });
  });

  it('the bursar recording it by its reference credits the school fee, and is recorded as the bursar\'s', async () => {
    const { reference } = await startAndVerify();
    const res = await request(app).post(`/api/schools/${A}/payments`).set('Authorization', bursar())
      .send({ invoice_id: invoiceId, amount: '30558.38', method: 'paystack', paystack_reference: reference });
    expect(res.status).toBe(201);
    expect(await payments()).toMatchObject([{ amount: '30000.00', paystack_reference: reference, recorded_by: BURSAR }]);
    expect(await checkouts()).toMatchObject([{ status: 'consumed' }]);
    // The webhook arriving afterwards changes nothing.
    await deliver(reference);
    expect(await payments()).toHaveLength(1);
    expect(await invoice()).toMatchObject({ amount_paid: '30000.00' });
  });

  it('the bursar naming another invoice for it is refused', async () => {
    const { reference } = await startAndVerify();
    const other = (await pool.query(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000.00, 0, 50000.00, 'unpaid') RETURNING id`, [A, I.s2, I.termA])).rows[0].id;
    const res = await request(app).post(`/api/schools/${A}/payments`).set('Authorization', bursar())
      .send({ invoice_id: other, amount: '30558.38', method: 'paystack', paystack_reference: reference });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_MISMATCH');
    expect(await payments()).toEqual([]);
  });

  it('a verified amount that is not the total is refused on the bursar\'s path too, and alerts', async () => {
    const { reference } = await startAndVerify(3_000_000);
    const error = jest.spyOn(logger, 'error');
    const res = await request(app).post(`/api/schools/${A}/payments`).set('Authorization', bursar())
      .send({ invoice_id: invoiceId, amount: '30000', method: 'paystack', paystack_reference: reference });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(await payments()).toEqual([]);
    expect(error).toHaveBeenCalledWith('paystack_fee_amount_mismatch', {
      route: 'fees_record_payment', school_id: A, expected_kobo: 3_055_838, verified_kobo: 3_000_000,
    });
    error.mockRestore();
  });

  it('a refund can return the school fee, never the convenience fee', async () => {
    const { reference } = await startAndVerify();
    await deliver(reference);
    const [p] = await payments();
    const refund = (amount: string) => request(app).post(`/api/schools/${A}/payments/${p.id}/refunds`)
      .set('Authorization', bursar()).send({ amount, method: 'bank_transfer', reason: 'withdrew' });
    const tooMuch = await refund('30558.38');
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
    expect((await refund('30000')).status).toBe(201);
    expect(await invoice()).toMatchObject({ amount_paid: '0.00', status: 'unpaid' });
  });
});

describe('a payment started before the setting existed, or by another path', () => {
  it('the bursar recording a payment no record started still uses Paystack\'s verified amount, as before', async () => {
    mockVerify.mockResolvedValue({ status: 'success', amountKobo: 1_250_000, currency: 'NGN', reference: 'outside-1', metadata: { school_id: A, invoice_id: invoiceId } });
    const res = await request(app).post(`/api/schools/${A}/payments`).set('Authorization', bursar())
      .send({ invoice_id: invoiceId, amount: '1', method: 'paystack', paystack_reference: 'outside-1' });
    expect(res.status).toBe(201);
    expect(await payments()).toMatchObject([{ amount: '12500.00', paystack_reference: 'outside-1' }]);
    expect(await getPaymentById(A, (await payments())[0].id)).toMatchObject({ convenience_fee_kobo: '0' });
  });
});
