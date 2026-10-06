import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import feesRouter from '../routes/fees';
import feesPublicRouter from '../routes/feesPublic';
import { errorHandler } from '../middleware/errorHandler';
import * as auditLog from '../db/queries/auditLog';
import * as paystackService from '../services/paystackService';
import * as paymentReceiptNotifier from '../services/paymentReceiptNotifier';
import * as feeCheckouts from '../db/queries/feeCheckouts';

// Regression test for the bug where `app.use('/api/schools', verifyToken)` was
// registered before the Paystack webhook/callback routes were mounted, so every
// webhook call 401'd before ever reaching the handler and no payment was ever
// recorded for online payments. Unlike fees.test.ts (which mounts the router
// bare, with no auth chain at all — the exact gap that let the bug ship), this
// test reproduces the FULL middleware chain from apps/api/src/index.ts so it
// actually exercises route registration order.
jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn().mockResolvedValue({ rows: [] }), end: jest.fn() },
}));
jest.mock('../db/queries/fees');
jest.mock('../db/queries/feeCheckouts');
jest.mock('../db/queries/platformBilling');
jest.mock('../db/queries/auditLog');
jest.mock('../services/paymentReceiptNotifier');
jest.mock('../services/receiptService', () => ({ generateReceipt: jest.fn() }));
jest.mock('../services/reportCardService', () => ({ signReportCardAsset: jest.fn() }));
// Only stub verifyPaystackTransaction — keep verifyPaystackWebhookSignature real so
// this test proves a genuinely-signed webhook request reaches the handler.
jest.mock('../services/paystackService', () => ({
  ...jest.requireActual('../services/paystackService'),
  verifyPaystackTransaction: jest.fn(),
}));

const mockAudit = auditLog as jest.Mocked<typeof auditLog>;
const mockPaystack = paystackService as jest.Mocked<typeof paystackService>;
const mockNotifier = paymentReceiptNotifier as jest.Mocked<typeof paymentReceiptNotifier>;
const mockCheckouts = feeCheckouts as jest.Mocked<typeof feeCheckouts>;

process.env.JWT_SECRET = 'test-secret';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_webhook_secret';

const SCHOOL_ID = 'school-uuid-001';
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';
const PAYMENT_AMOUNT = 10000;
/** Paystack reports kobo on both the webhook payload and the verify response. */
const PAYMENT_AMOUNT_KOBO = PAYMENT_AMOUNT * 100;

const CHARGE_SUCCESS_EVENT = {
  event: 'charge.success',
  data: {
    reference: 'ref-xyz',
    amount: PAYMENT_AMOUNT_KOBO,
    metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
  },
};

const PAYMENT_RESULT = {
  payment: {
    id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
    payment_date: '', method: 'paystack', reference: null, paystack_reference: 'ref-xyz',
    recorded_by: 'user-uuid-001', created_at: '',
  },
  invoice: {
    id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: 'term-1',
    total_amount: PAYMENT_AMOUNT, amount_paid: PAYMENT_AMOUNT, balance: 0, status: 'paid',
    created_at: '', updated_at: '',
  },
};

/** Signs a raw request body exactly the way Paystack signs real webhook deliveries
 *  (HMAC-SHA512 with the account secret key), so verifyPaystackWebhookSignature's
 *  real implementation accepts it. */
function signWebhookBody(rawBody: string): string {
  return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(rawBody).digest('hex');
}

/** Builds the app with the SAME middleware chain and mount order as
 *  apps/api/src/index.ts — this is intentionally NOT a bare router mount.
 *  Keep this in sync with index.ts's `/api/schools` mounts. */
function buildFullStackApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request).rawBody = buf;
    },
  }));
  app.use('/api/schools', feesPublicRouter);
  app.use('/api/schools', detectSupportSession);
  app.use('/api/schools', verifyToken);
  app.use('/api/schools', requireActiveSchool);
  app.use('/api/schools', feesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/schools/:schoolId/payments/paystack/webhook (full middleware stack)', () => {
  it('reaches the handler with no Authorization header and credits the invoice', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({
      status: 'success', amountKobo: PAYMENT_AMOUNT_KOBO, currency: 'NGN', reference: 'ref-xyz',
      metadata: CHARGE_SUCCESS_EVENT.data.metadata,
    });
    // Where it is credited is decided by the payment's record (migration 062; feeCheckouts.db.test.ts).
    mockCheckouts.settleFeeCheckout.mockResolvedValueOnce({
      outcome: 'credited', payment: PAYMENT_RESULT.payment, invoice: PAYMENT_RESULT.invoice, schoolId: SCHOOL_ID, recordedBy: 'user-uuid-001',
    } as never);

    const app = buildFullStackApp();
    const rawBody = JSON.stringify(CHARGE_SUCCESS_EVENT);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('Content-Type', 'application/json')
      .set('X-Paystack-Signature', signWebhookBody(rawBody))
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(true);
    // Kobo end to end: Paystack reports kobo, the webhook passes it through, and settlement
    // takes kobo. Nothing divides by 100 and multiplies back.
    expect(mockCheckouts.settleFeeCheckout).toHaveBeenCalledWith('ref-xyz', PAYMENT_AMOUNT_KOBO, 'NGN');
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });
});
