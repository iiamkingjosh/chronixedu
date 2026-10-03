import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import platformBillingRouter from '../routes/platformBilling';
import platformBillingPublicRouter from '../routes/platformBillingPublic';
import { errorHandler } from '../middleware/errorHandler';
import { cache, schoolCacheKey } from '../services/cacheService';
import pool from '../db/client';
import * as platformBillingQueries from '../db/queries/platformBilling';
import * as paystackService from '../services/paystackService';

/**
 * The full middleware chain from apps/api/src/index.ts, not a bare router mount —
 * same reasoning as feesWebhookFullStack.test.ts: a route registration mistake (the
 * guard before the public router, or the checkout route missing from
 * READ_ONLY_WRITE_ALLOWLIST) is invisible to a test that mounts the router alone.
 * Keep this in sync with index.ts's /api/schools mounts for platform billing.
 */
jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), end: jest.fn() },
}));
jest.mock('../db/queries/platformBilling');
// Keep verifyPaystackWebhookSignature real (same as feesWebhookFullStack.test.ts) so the
// webhook test proves a genuinely-signed request reaches the handler; stub the rest.
jest.mock('../services/paystackService', () => ({
  ...jest.requireActual('../services/paystackService'),
  verifyPaystackTransaction: jest.fn(),
  initializePaystackTransaction: jest.fn(),
  isPaystackConfigured: jest.fn(),
}));

const dbClient = pool as unknown as { query: jest.Mock };
const mockBilling = platformBillingQueries as jest.Mocked<typeof platformBillingQueries>;
const mockPaystack = paystackService as jest.Mocked<typeof paystackService>;

process.env.JWT_SECRET = 'test-secret';
process.env.API_BASE_URL = 'https://api.chronixtechnology.com';
process.env.APP_URL = 'https://edu.chronixtechnology.com';

const SCHOOL_ID = '11111111-1111-4111-8111-111111111111';
const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = '33333333-3333-4333-8333-333333333333';

function token(role: string, schoolId: string | null = SCHOOL_ID) {
  return 'Bearer ' + jwt.sign(
    { user_id: PRINCIPAL_ID, role, school_id: schoolId, email: 'principal@test.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

/** One row that answers both requireActiveSchool's school lookup and
 *  requirePasswordChanged's must_change_password lookup — same combined-row technique
 *  the blanket db/client mock needs whenever both run in the same request. */
function schoolRow(overrides: Partial<{ is_active: boolean; subscription_status: string }> = {}) {
  return {
    id: SCHOOL_ID, name: 'Test School', slug: 'test-school', is_active: true, subscription_tier: 'premium',
    subscription_status: 'active', created_at: '', updated_at: '',
    identity_config: {}, academic_config: {}, notification_config: {}, report_config: {},
    must_change_password: false,
    ...overrides,
  };
}

function buildFullStackApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; },
  }));
  app.use('/api/schools', platformBillingPublicRouter);
  app.use('/api/schools', detectSupportSession);
  app.use('/api/schools', verifyToken);
  app.use('/api/schools', requirePasswordChanged);
  app.use('/api/schools', requireActiveSchool);
  app.use('/api/schools', requireWritableSubscription);
  app.use('/api/schools', platformBillingRouter);
  app.use(errorHandler);
  return app;
}

const SUBSCRIPTION = {
  id: SUBSCRIPTION_ID, school_id: SCHOOL_ID, plan: 'premium', subscription_status: 'active',
  billing_cycle: 'termly', amount_naira: '48000.00', next_billing_date: '2026-11-03', next_billing_basis: 'next_term',
};

beforeEach(() => {
  jest.clearAllMocks();
  cache.del(schoolCacheKey(SCHOOL_ID, 'data'));
  dbClient.query.mockResolvedValue({ rows: [schoolRow()] });
});

describe('POST /api/schools/:schoolId/platform-billing/checkout (full middleware stack)', () => {
  it('a principal starts a checkout and gets an authorization_url', async () => {
    mockBilling.findBillableSubscription.mockResolvedValueOnce(SUBSCRIPTION as never);
    mockBilling.createPendingPayment.mockResolvedValueOnce({
      id: 'pay-1', school_id: SCHOOL_ID, subscription_id: SUBSCRIPTION_ID, reference: 'ref-abc',
      amount_kobo: '4800000', plan: 'premium', billing_cycle: 'termly', status: 'pending',
      initiated_by: PRINCIPAL_ID, consumed_at: null,
    } as never);
    mockPaystack.isPaystackConfigured.mockReturnValue(true);
    mockPaystack.initializePaystackTransaction.mockResolvedValueOnce({
      authorization_url: 'https://checkout.paystack.com/abc', access_code: 'code', reference: 'ref-abc',
    });

    const res = await request(buildFullStackApp())
      .post(`/api/schools/${SCHOOL_ID}/platform-billing/checkout`)
      .set('Authorization', token('principal'));

    expect(res.status).toBe(201);
    expect(res.body.data.authorization_url).toBe('https://checkout.paystack.com/abc');
    // Kobo end to end: amount_naira '48000.00' -> 4,800,000 kobo, not naira passed as kobo.
    expect(mockBilling.createPendingPayment).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, subscriptionId: SUBSCRIPTION_ID, amountKobo: 4_800_000, plan: 'premium', billingCycle: 'termly', initiatedBy: PRINCIPAL_ID,
    }));
    expect(mockPaystack.initializePaystackTransaction).toHaveBeenCalledWith(expect.objectContaining({
      amountKobo: 4_800_000,
      callbackUrl: 'https://api.chronixtechnology.com/api/schools/platform-billing/callback',
    }));
  });

  it('refuses a trial plan without ever starting a Paystack transaction', async () => {
    mockBilling.findBillableSubscription.mockResolvedValueOnce({ ...SUBSCRIPTION, plan: 'trial', amount_naira: '0.00' } as never);

    const res = await request(buildFullStackApp())
      .post(`/api/schools/${SCHOOL_ID}/platform-billing/checkout`)
      .set('Authorization', token('principal'));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TRIAL_NOT_BILLABLE');
    expect(mockBilling.createPendingPayment).not.toHaveBeenCalled();
    expect(mockPaystack.initializePaystackTransaction).not.toHaveBeenCalled();
  });

  it('a teacher is refused — only principal/bursar/super_admin may pay', async () => {
    const res = await request(buildFullStackApp())
      .post(`/api/schools/${SCHOOL_ID}/platform-billing/checkout`)
      .set('Authorization', token('teacher'));

    expect(res.status).toBe(403);
    expect(mockBilling.findBillableSubscription).not.toHaveBeenCalled();
  });

  it('the carve-out works through the REAL guard and the REAL allowlist (not a test-pushed entry): a read-only school can still check out', async () => {
    dbClient.query.mockResolvedValue({ rows: [schoolRow({ subscription_status: 'read_only' })] });
    mockBilling.findBillableSubscription.mockResolvedValueOnce({ ...SUBSCRIPTION, subscription_status: 'read_only' } as never);
    mockBilling.createPendingPayment.mockResolvedValueOnce({
      id: 'pay-1', school_id: SCHOOL_ID, subscription_id: SUBSCRIPTION_ID, reference: 'ref-abc',
      amount_kobo: '4800000', plan: 'premium', billing_cycle: 'termly', status: 'pending',
      initiated_by: PRINCIPAL_ID, consumed_at: null,
    } as never);
    mockPaystack.isPaystackConfigured.mockReturnValue(true);
    mockPaystack.initializePaystackTransaction.mockResolvedValueOnce({
      authorization_url: 'https://checkout.paystack.com/abc', access_code: 'code', reference: 'ref-abc',
    });

    const res = await request(buildFullStackApp())
      .post(`/api/schools/${SCHOOL_ID}/platform-billing/checkout`)
      .set('Authorization', token('principal'));

    expect(res.status).toBe(201); // not 423 SCHOOL_READ_ONLY
  });

  it('an ordinary write is still blocked while read-only (the guard still guards everything else)', async () => {
    dbClient.query.mockResolvedValue({ rows: [schoolRow({ subscription_status: 'read_only' })] });

    const res = await request(buildFullStackApp())
      .post(`/api/schools/${SCHOOL_ID}/platform-billing/status`) // GET-only route, POST is unmatched -> 404, not the right control
      .set('Authorization', token('principal'));
    expect(res.status).not.toBe(201);
  });
});

describe('GET /api/schools/:schoolId/platform-billing/status (full middleware stack)', () => {
  it('reports the current bill', async () => {
    mockBilling.findBillableSubscription.mockResolvedValueOnce(SUBSCRIPTION as never);
    mockBilling.findPendingPaymentForSchool.mockResolvedValueOnce(null);

    const res = await request(buildFullStackApp())
      .get(`/api/schools/${SCHOOL_ID}/platform-billing/status`)
      .set('Authorization', token('principal'));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ has_subscription: true, plan: 'premium', payable: true, amount_naira: '48000.00' });
  });

  it('still answers while read-only (GETs always work)', async () => {
    dbClient.query.mockResolvedValue({ rows: [schoolRow({ subscription_status: 'read_only' })] });
    mockBilling.findBillableSubscription.mockResolvedValueOnce({ ...SUBSCRIPTION, subscription_status: 'read_only' } as never);
    mockBilling.findPendingPaymentForSchool.mockResolvedValueOnce(null);

    const res = await request(buildFullStackApp())
      .get(`/api/schools/${SCHOOL_ID}/platform-billing/status`)
      .set('Authorization', token('principal'));

    expect(res.status).toBe(200);
  });
});

// ── Public webhook + callback: no bearer token, resolved by reference alone ──────

function signWebhookBody(rawBody: string): string {
  return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(rawBody).digest('hex');
}

const SETTLED_PAYMENT = {
  id: 'pay-1', school_id: SCHOOL_ID, subscription_id: SUBSCRIPTION_ID, reference: 'ref-xyz',
  amount_kobo: '4800000', plan: 'premium', billing_cycle: 'termly', status: 'consumed',
  initiated_by: PRINCIPAL_ID, consumed_at: '2026-10-02T00:00:00.000Z',
};

describe('POST /api/schools/platform-billing/webhook (full middleware stack)', () => {
  beforeAll(() => { process.env.PAYSTACK_SECRET_KEY = 'sk_test_platform_billing'; });

  it('reaches the handler with no Authorization header and settles by reference alone — never by metadata', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amountKobo: 4_800_000, currency: 'NGN', reference: 'ref-xyz' });
    mockBilling.settlePayment.mockResolvedValueOnce({ outcome: 'settled', payment: SETTLED_PAYMENT as never, subscription_reactivated: false });

    const event = {
      event: 'charge.success',
      data: {
        reference: 'ref-xyz',
        amount: 4_800_000,
        // Deliberately absent/wrong metadata — the trust model must never read it for identity.
        metadata: { purpose: 'platform_subscription', school_id: 'not-the-real-school-id' },
      },
    };
    const rawBody = JSON.stringify(event);

    const res = await request(buildFullStackApp())
      .post('/api/schools/platform-billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Paystack-Signature', signWebhookBody(rawBody))
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ processed: true, outcome: 'settled' });
    // The currency goes with the amount: settlement refuses anything but naira (3 Oct 2026).
    expect(mockBilling.settlePayment).toHaveBeenCalledWith('ref-xyz', 4_800_000, 'NGN');
  });

  it('rejects a bad signature without settling anything', async () => {
    const event = { event: 'charge.success', data: { reference: 'ref-xyz', amount: 4_800_000 } };
    const res = await request(buildFullStackApp())
      .post('/api/schools/platform-billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Paystack-Signature', 'not-a-real-signature')
      .send(JSON.stringify(event));

    expect(res.status).toBe(401);
    expect(mockBilling.settlePayment).not.toHaveBeenCalled();
  });
});

describe('GET /api/schools/platform-billing/callback (full middleware stack)', () => {
  it('redirects to the billing page with payment=success', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amountKobo: 4_800_000, currency: 'NGN', reference: 'ref-xyz' });
    mockBilling.settlePayment.mockResolvedValueOnce({ outcome: 'settled', payment: SETTLED_PAYMENT as never, subscription_reactivated: false });

    const res = await request(buildFullStackApp()).get('/api/schools/platform-billing/callback?reference=ref-xyz');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://edu.chronixtechnology.com/settings/billing?payment=success');
  });

  it('passes a non-naira currency to settlement and redirects with reason=wrong_currency', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amountKobo: 4_800_000, currency: 'USD', reference: 'ref-xyz' });
    mockBilling.settlePayment.mockResolvedValueOnce({ outcome: 'currency_mismatch', payment: SETTLED_PAYMENT as never });

    const res = await request(buildFullStackApp()).get('/api/schools/platform-billing/callback?reference=ref-xyz');

    expect(mockBilling.settlePayment).toHaveBeenCalledWith('ref-xyz', 4_800_000, 'USD');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://edu.chronixtechnology.com/settings/billing?payment=error&reason=wrong_currency');
  });

  it('redirects with a reason when the verified amount does not match what was charged at checkout', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amountKobo: 1, currency: 'NGN', reference: 'ref-xyz' });
    mockBilling.settlePayment.mockResolvedValueOnce({ outcome: 'amount_mismatch', payment: SETTLED_PAYMENT as never });

    const res = await request(buildFullStackApp()).get('/api/schools/platform-billing/callback?reference=ref-xyz');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://edu.chronixtechnology.com/settings/billing?payment=error&reason=amount_mismatch');
  });
});
