/**
 * Naira only (3 Oct 2026). Paystack reports each verified transaction's currency, and nothing read it,
 * so a payment in another currency would have been recorded as that many kobo: 80,000 US cents would
 * have settled an ₦800 bill. Every other currency Paystack supports is worth more per minor unit, so
 * the payer always overpays; the harm is money that arrived and must be refunded. Each refusal is
 * shown beside the same payment in naira being recorded (doctrine 16).
 */
import request from 'supertest';
import express from 'express';
import { seed, IDS as I, pool } from './helpers';
import feesPublicRoutes from '../routes/feesPublic';
import { errorHandler } from '../middleware/errorHandler';
import { settlePayment } from '../db/queries/platformBilling';
import { logger } from '../config/logger';

jest.mock('../services/paystackService', () => ({
  ...jest.requireActual('../services/paystackService'),
  verifyPaystackTransaction: jest.fn(),
}));
// The receipt email is not under test here.
jest.mock('../services/paymentReceiptNotifier', () => ({ notifyPaymentReceipt: jest.fn() }));
/* eslint-disable @typescript-eslint/no-var-requires */
const paystack = require('../services/paystackService');
/* eslint-enable @typescript-eslint/no-var-requires */
const verify = paystack.verifyPaystackTransaction as jest.Mock;

const app = express();
app.use('/api/schools', feesPublicRoutes);
app.use(errorHandler);

beforeEach(async () => { await seed(); verify.mockReset(); });
afterAll(async () => { await pool.end(); });

async function invoice(studentId: string, totalNaira: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
     VALUES ($1, $2, $3, $4, 0, $4, 'unpaid') RETURNING id`, [I.schoolA, studentId, I.termA, totalNaira]);
  return rows[0].id;
}
const invoiceState = async (id: string) => (await pool.query<{ amount_paid: string; status: string }>(
  `SELECT amount_paid, status FROM fee_invoices WHERE id = $1`, [id])).rows[0];
const paymentsFor = async (id: string) => Number((await pool.query(
  `SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1`, [id])).rows[0].n);
const callback = (reference: string) =>
  request(app).get(`/api/schools/${I.schoolA}/payments/paystack/callback?reference=${reference}`);

describe('a parent paying a fee online', () => {
  it('is recorded when Paystack verifies naira, and refused, unrecorded and alerted when it verifies another currency', async () => {
    // The control: the same 80,000 minor units, in naira, pay the ₦800 invoice.
    const paidInNaira = await invoice(I.s1, '800.00');
    verify.mockResolvedValueOnce({ status: 'success', amountKobo: 80000, currency: 'NGN', reference: 'ref-ngn', metadata: { school_id: I.schoolA, invoice_id: paidInNaira } });
    const ok = await callback('ref-ngn');
    expect(ok.headers.location).toMatch(/payment=success$/);
    expect(await paymentsFor(paidInNaira)).toBe(1);
    expect(await invoiceState(paidInNaira)).toEqual({ amount_paid: '800.00', status: 'paid' });

    const paidInDollars = await invoice(I.s2, '800.00');
    verify.mockResolvedValueOnce({ status: 'success', amountKobo: 80000, currency: 'USD', reference: 'ref-usd', metadata: { school_id: I.schoolA, invoice_id: paidInDollars } });
    const error = jest.spyOn(logger, 'error');
    const refused = await callback('ref-usd');
    expect(refused.headers.location).toMatch(/payment=error&reason=wrong_currency$/);
    expect(await paymentsFor(paidInDollars)).toBe(0);
    expect(await invoiceState(paidInDollars)).toEqual({ amount_paid: '0.00', status: 'unpaid' });
    expect(error).toHaveBeenCalledWith('paystack_payment_not_naira', expect.objectContaining({ route: 'fees_callback', currency: 'USD' }));
    error.mockRestore();
  });
});

describe('a school paying Chronix online', () => {
  async function pendingPayment(reference: string): Promise<string> {
    const admin = '7e570000-0000-4000-8000-0000000000c1';
    await pool.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password, two_factor_required)
       VALUES ($1, NULL, $2, 'x', 'super_admin', 'Pay', 'Admin', true, 'subject', false, false) ON CONFLICT (id) DO NOTHING`, [admin, `${admin}@test`]);
    const sub = await pool.query<{ id: string }>(
      `INSERT INTO platform_subscriptions (school_id, plan, subscription_status) VALUES ($1, 'trial', 'trial')
       ON CONFLICT DO NOTHING RETURNING id`, [I.schoolA]);
    const subscriptionId = sub.rows[0]?.id ?? (await pool.query<{ id: string }>(`SELECT id FROM platform_subscriptions WHERE school_id = $1`, [I.schoolA])).rows[0].id;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO platform_subscription_payments (school_id, subscription_id, reference, amount_kobo, plan, billing_cycle, initiated_by)
       VALUES ($1, $2, $3, 80000, 'premium', 'termly', $4) RETURNING id`, [I.schoolA, subscriptionId, reference, admin]);
    return rows[0].id;
  }
  const status = async (id: string) => (await pool.query<{ status: string }>(`SELECT status FROM platform_subscription_payments WHERE id = $1`, [id])).rows[0].status;

  it('settles a naira payment, and fails one in another currency with the same figure', async () => {
    const naira = await pendingPayment('plat-ngn');
    expect((await settlePayment('plat-ngn', 80000, 'NGN')).outcome).toBe('settled');
    expect(await status(naira)).toBe('consumed');

    const dollars = await pendingPayment('plat-usd');
    const error = jest.spyOn(logger, 'error');
    expect((await settlePayment('plat-usd', 80000, 'USD')).outcome).toBe('currency_mismatch');
    expect(await status(dollars)).toBe('failed');
    expect(error).toHaveBeenCalledWith('platform_billing_currency_mismatch', expect.objectContaining({ currency: 'USD' }));
    error.mockRestore();
  });
});
