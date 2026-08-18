import request from 'supertest';
import express from 'express';
import feesPublicRouter from '../routes/feesPublic';
import { errorHandler } from '../middleware/errorHandler';
import * as feesQueries from '../db/queries/fees';
import * as auditLog from '../db/queries/auditLog';
import * as paystackService from '../services/paystackService';
import * as paymentReceiptNotifier from '../services/paymentReceiptNotifier';

jest.mock('../db/queries/fees');
jest.mock('../db/queries/auditLog');
jest.mock('../services/paystackService');
jest.mock('../services/paymentReceiptNotifier');
jest.mock('../services/receiptService', () => ({ generateReceipt: jest.fn() }));
jest.mock('../services/reportCardService', () => ({ signReportCardAsset: jest.fn() }));

const mockFees = feesQueries as jest.Mocked<typeof feesQueries>;
const mockAudit = auditLog as jest.Mocked<typeof auditLog>;
const mockPaystack = paystackService as jest.Mocked<typeof paystackService>;
const mockNotifier = paymentReceiptNotifier as jest.Mocked<typeof paymentReceiptNotifier>;

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
const INVOICE_TOTAL_AMOUNT = 15000;

beforeEach(() => jest.clearAllMocks());

// ── GET /:schoolId/payments/paystack/callback ───────────────────────────────────

describe('GET /api/schools/:schoolId/payments/paystack/callback', () => {
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'paystack', reference: null, paystack_reference: 'ref-xyz',
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };

  const SUCCESS_VERIFICATION = {
    status: 'success',
    amount: PAYMENT_AMOUNT,
    currency: 'NGN',
    reference: 'ref-xyz',
    metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
  };

  it('verifies the transaction, records the payment, and redirects with payment=success', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(SUCCESS_VERIFICATION);
    mockFees.recordPayment.mockResolvedValueOnce(PAYMENT_RESULT as never);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=success');
    expect(mockFees.recordPayment).toHaveBeenCalledWith(SCHOOL_ID, INVOICE_ID, {
      amount: PAYMENT_AMOUNT, method: 'paystack', reference: null, paystack_reference: 'ref-xyz', recorded_by: 'user-uuid-001',
    });
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });

  it('redirects with payment=error when reference is missing', async () => {
    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=error when verification fails', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=failed when the transaction was not successful', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ ...SUCCESS_VERIFICATION, status: 'failed' });

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=failed');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=error when metadata does not match the school in the URL', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({
      ...SUCCESS_VERIFICATION,
      metadata: { ...SUCCESS_VERIFICATION.metadata, school_id: 'other-school' },
    });

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=success when the paystack reference was already recorded (idempotent)', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(SUCCESS_VERIFICATION);
    const dbError = new Error('duplicate key value violates unique constraint "payments_paystack_reference_key"') as Error & { code: string };
    dbError.code = '23505';
    mockFees.recordPayment.mockRejectedValueOnce(dbError);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=success');
  });

  it('redirects with payment=error when the invoice no longer exists', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(SUCCESS_VERIFICATION);
    mockFees.recordPayment.mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
  });
});

// ── POST /:schoolId/payments/paystack/webhook ───────────────────────────────────

describe('POST /api/schools/:schoolId/payments/paystack/webhook', () => {
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'paystack', reference: null, paystack_reference: 'ref-xyz',
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };

  const CHARGE_SUCCESS_EVENT = {
    event: 'charge.success',
    data: {
      reference: 'ref-xyz',
      amount: PAYMENT_AMOUNT * 100,
      metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
    },
  };

  it('returns 401 when the signature is invalid', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(false);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'bad-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns 401 when the signature header is missing', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('ignores events that are not charge.success', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send({ event: 'transfer.success', data: {} });

    expect(res.status).toBe(200);
    expect(res.body.data.ignored).toBe(true);
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('records the payment on charge.success and logs audit', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amount: PAYMENT_AMOUNT, currency: 'NGN' });
    mockFees.recordPayment.mockResolvedValueOnce(PAYMENT_RESULT as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(true);
    expect(mockFees.recordPayment).toHaveBeenCalledWith(SCHOOL_ID, INVOICE_ID, {
      amount: PAYMENT_AMOUNT, method: 'paystack', reference: null, paystack_reference: 'ref-xyz', recorded_by: 'user-uuid-001',
    });
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });

  it('ignores events whose metadata school_id does not match the URL', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send({
        event: 'charge.success',
        data: { ...CHARGE_SUCCESS_EVENT.data, metadata: { ...CHARGE_SUCCESS_EVENT.data.metadata, school_id: 'other-school' } },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.ignored).toBe(true);
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns processed:false (duplicate) for an already-recorded paystack reference', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amount: PAYMENT_AMOUNT, currency: 'NGN' });
    const dbError = new Error('duplicate key value violates unique constraint "payments_paystack_reference_key"') as Error & { code: string };
    dbError.code = '23505';
    mockFees.recordPayment.mockRejectedValueOnce(dbError);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(false);
    expect(res.body.data.duplicate).toBe(true);
    expect(mockNotifier.notifyPaymentReceipt).not.toHaveBeenCalled();
  });

  it('returns processed:false when the invoice no longer exists', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockFees.recordPayment.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(false);
  });
});
