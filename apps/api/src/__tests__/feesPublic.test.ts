import request from 'supertest';
import express from 'express';
import feesPublicRouter from '../routes/feesPublic';
import { errorHandler } from '../middleware/errorHandler';
import * as auditLog from '../db/queries/auditLog';
import * as paystackService from '../services/paystackService';
import * as paymentReceiptNotifier from '../services/paymentReceiptNotifier';
import * as feeCheckouts from '../db/queries/feeCheckouts';
import * as platformBilling from '../db/queries/platformBilling';
import { logger } from '../config/logger';

jest.mock('../db/queries/fees');
// Where a payment is credited is decided by its record (migration 062), tested against the
// database in feeCheckouts.db.test.ts. Here: what each route does with each answer.
jest.mock('../db/queries/feeCheckouts');
jest.mock('../db/queries/platformBilling');
jest.mock('../db/queries/auditLog');
// Automatic stubs for every Paystack call, except the naira check, which runs for real: a stub would
// answer undefined, and the routes would refuse every payment as not naira (3 Oct 2026).
jest.mock('../services/paystackService', () => ({
  ...jest.createMockFromModule<object>('../services/paystackService'),
  isNairaPayment: jest.requireActual('../services/paystackService').isNairaPayment,
}));
jest.mock('../services/paymentReceiptNotifier');
jest.mock('../services/receiptService', () => ({ generateReceipt: jest.fn() }));
jest.mock('../services/reportCardService', () => ({ signReportCardAsset: jest.fn() }));

const mockAudit = auditLog as jest.Mocked<typeof auditLog>;
const mockPaystack = paystackService as jest.Mocked<typeof paystackService>;
const mockNotifier = paymentReceiptNotifier as jest.Mocked<typeof paymentReceiptNotifier>;
const mockCheckouts = feeCheckouts as jest.Mocked<typeof feeCheckouts>;
const mockPlatform = platformBilling as jest.Mocked<typeof platformBilling>;

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).rawBody = buf;
  },
}));
app.use('/api/schools', feesPublicRouter);
app.use(errorHandler);

const SCHOOL_ID = 'school-uuid-001';
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';
const TERM_ID = '11111111-1111-4111-8111-111111111111';
const PAYMENT_AMOUNT = 10000;
/** Paystack reports kobo, and recordPayment now takes kobo. */
const PAYMENT_AMOUNT_KOBO = PAYMENT_AMOUNT * 100;
const INVOICE_TOTAL_AMOUNT = 15000;

beforeEach(() => jest.clearAllMocks());

// ── What a settlement answer turns into ──────────────────────────────────────────

const PAYMENT = {
  id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
  payment_date: '', method: 'paystack' as const, reference: null, paystack_reference: 'ref-xyz',
  recorded_by: 'user-uuid-001', created_at: '',
};
const INVOICE = {
  id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
  total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid' as const,
  created_at: '', updated_at: '',
};
const CREDITED = { outcome: 'credited' as const, payment: PAYMENT, invoice: INVOICE, schoolId: SCHOOL_ID, recordedBy: 'user-uuid-001' };
const VERIFIED = { status: 'success', amountKobo: PAYMENT_AMOUNT_KOBO, currency: 'NGN', reference: 'ref-xyz' };

// ── GET /:schoolId/payments/paystack/callback ───────────────────────────────────

describe('GET /api/schools/:schoolId/payments/paystack/callback', () => {
  const back = () => request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

  it('credits through the record, audits, sends the receipt and redirects with payment=success', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(VERIFIED);
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce(CREDITED);

    const res = await back();

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=success');
    // Kobo end to end, and the currency with it.
    expect(mockCheckouts.settleFeeCheckout).toHaveBeenCalledWith('ref-xyz', PAYMENT_AMOUNT_KOBO, 'NGN');
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, userId: 'user-uuid-001', actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });

  it('redirects with payment=error when reference is missing', async () => {
    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback`);
    expect(res.headers.location).toContain('payment=error');
    expect(mockCheckouts.settleFeeCheckout).not.toHaveBeenCalled();
  });

  it('redirects with payment=error when verification fails', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(null);
    const res = await back();
    expect(res.headers.location).toContain('payment=error');
    expect(mockCheckouts.settleFeeCheckout).not.toHaveBeenCalled();
  });

  it('redirects with payment=failed when the transaction was not successful', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ ...VERIFIED, status: 'failed' });
    const res = await back();
    expect(res.headers.location).toContain('payment=failed');
    expect(mockCheckouts.settleFeeCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['no_checkout', { outcome: 'no_checkout' as const }, 'unknown_payment'],
    ['not_naira', { outcome: 'not_naira' as const, schoolId: SCHOOL_ID, currency: 'USD' }, 'wrong_currency'],
    ['amount_mismatch', { outcome: 'amount_mismatch' as const, schoolId: SCHOOL_ID, expectedKobo: 1, verifiedKobo: 2 }, 'amount_mismatch'],
    ['invoice_missing', { outcome: 'invoice_missing' as const, schoolId: SCHOOL_ID }, 'invoice_not_found'],
  ])('%s: redirects with its reason and records nothing', async (_name, settled, reason) => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(VERIFIED);
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce(settled);
    const res = await back();
    expect(res.headers.location).toContain(`payment=error&reason=${reason}`);
    expect(mockAudit.logAudit).not.toHaveBeenCalled();
    expect(mockNotifier.notifyPaymentReceipt).not.toHaveBeenCalled();
  });

  it('already credited (the webhook usually wins): success, without a second receipt or audit row', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(VERIFIED);
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce({ outcome: 'duplicate', schoolId: SCHOOL_ID });
    const res = await back();
    expect(res.headers.location).toContain('payment=success');
    expect(mockNotifier.notifyPaymentReceipt).not.toHaveBeenCalled();
    expect(mockAudit.logAudit).not.toHaveBeenCalled();
  });
});

// ── POST /:schoolId/payments/paystack/webhook ───────────────────────────────────

describe('POST /api/schools/:schoolId/payments/paystack/webhook', () => {
  const CHARGE_SUCCESS_EVENT = { event: 'charge.success', data: { reference: 'ref-xyz' } };
  const hook = (body: object = CHARGE_SUCCESS_EVENT, signature = 'good-signature') =>
    request(app).post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`).set('X-Paystack-Signature', signature).send(body);

  it('returns 401 when the signature is invalid', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(false);
    const res = await hook(CHARGE_SUCCESS_EVENT, 'bad-signature');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(mockCheckouts.settleFeeCheckout).not.toHaveBeenCalled();
  });

  it('returns 401 when the signature header is missing', async () => {
    const res = await request(app).post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`).send(CHARGE_SUCCESS_EVENT);
    expect(res.status).toBe(401);
  });

  it('any other event is acknowledged and logged by name, never dropped silently', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    const warn = jest.spyOn(logger, 'warn');
    const res = await hook({ event: 'transfer.success', data: {} });
    expect(res.status).toBe(200);
    expect(res.body.data.ignored).toBe(true);
    expect(warn).toHaveBeenCalledWith('paystack_event_unhandled', { event: 'transfer.success' });
    expect(mockCheckouts.settleFeeCheckout).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('credits through the record on charge.success, audits with no address, and sends the receipt', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(VERIFIED);
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce(CREDITED);
    const res = await hook();
    expect(res.body.data).toEqual({ processed: true });
    expect(mockCheckouts.settleFeeCheckout).toHaveBeenCalledWith('ref-xyz', PAYMENT_AMOUNT_KOBO, 'NGN');
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({ ipAddress: null, actionType: 'PAYMENT_RECORDED', entityId: 'pay-1' }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });

  it('a payment no fee record started goes to Chronix\'s own subscription payments, by reference', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(VERIFIED);
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce({ outcome: 'no_checkout' });
    mockPlatform.settlePayment.mockResolvedValueOnce({ outcome: 'settled' } as never);
    const res = await hook();
    expect(res.body.data).toEqual({ processed: true, outcome: 'settled' });
    expect(mockPlatform.settlePayment).toHaveBeenCalledWith('ref-xyz', PAYMENT_AMOUNT_KOBO, 'NGN');
  });

  it('a payment nothing started is not credited, and alerts', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(VERIFIED);
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce({ outcome: 'no_checkout' });
    mockPlatform.settlePayment.mockResolvedValueOnce({ outcome: 'not_found' });
    const error = jest.spyOn(logger, 'error');
    const res = await hook();
    expect(res.body.data).toEqual({ processed: false, reason: 'no_checkout' });
    expect(error).toHaveBeenCalledWith('paystack_fee_payment_unmatched', { route: 'fees_webhook', paystack_reference: 'ref-xyz' });
    expect(mockAudit.logAudit).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('already credited: acknowledged as a duplicate, nothing sent twice', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(VERIFIED);
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce({ outcome: 'duplicate', schoolId: SCHOOL_ID });
    const res = await hook();
    expect(res.body.data).toEqual({ processed: false, duplicate: true });
    expect(mockNotifier.notifyPaymentReceipt).not.toHaveBeenCalled();
  });
});
