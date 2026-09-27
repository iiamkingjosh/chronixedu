/**
 * The ERP integration endpoint.
 *
 * This is the first route in the product authenticated by a shared secret rather than a
 * human session, so its auth boundary is the entire safety argument and is tested
 * directly: no key, wrong key, right key, and — the one that matters most — an
 * unconfigured server, which must answer 503 rather than falling open.
 *
 * The figure itself is checked against `getPlatformRevenue` rather than recomputed here,
 * because the point of that function is that the ERP and the super-admin dashboard cannot
 * report different MRR. A test with its own arithmetic would be a third implementation of
 * the thing being deduplicated.
 */
import request from 'supertest';
import express from 'express';
import { seed, IDS as I, pool } from './helpers';
import partnerRoutes from '../routes/partner';
import { errorHandler } from '../middleware/errorHandler';
import { getPlatformRevenue } from '../db/queries/platformRevenue';

const app = express();
app.use(express.json());
app.use('/api/partner', partnerRoutes);
app.use(errorHandler);

const KEY = 'test-erp-key-that-is-long-enough-1234567890';
const originalKey = process.env.ERP_INTEGRATION_API_KEY;

beforeEach(async () => {
  await seed();
  process.env.ERP_INTEGRATION_API_KEY = KEY;
});
afterAll(async () => {
  if (originalKey === undefined) delete process.env.ERP_INTEGRATION_API_KEY;
  else process.env.ERP_INTEGRATION_API_KEY = originalKey;
  await pool.end();
});

const get = (key?: string) => {
  const r = request(app).get('/api/partner/revenue');
  return key === undefined ? r : r.set('X-API-Key', key);
};

/** An active subscription for School A, which the seed leaves without one. */
async function subscribe(schoolId: string, plan: string, cycle: string, naira: string) {
  await pool.query(
    `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, amount_naira, subscription_status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [schoolId, plan, cycle, naira]
  );
}

describe('the API key boundary', () => {
  it('refuses a request with no key at all', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses a wrong key of the same length', async () => {
    const wrong = 'x'.repeat(KEY.length);
    expect(wrong.length).toBe(KEY.length); // the case a length check alone would pass
    expect((await get(wrong)).status).toBe(401);
  });

  it('refuses a key that is a prefix of the real one', async () => {
    expect((await get(KEY.slice(0, -1))).status).toBe(401);
  });

  it('refuses a multi-byte key rather than throwing a 500', async () => {
    // Buffer.from('é').length is 2 but 'é'.length is 1, so a character-length check
    // followed by timingSafeEqual would throw and surface as an unhandled 500.
    expect((await get('é'.repeat(KEY.length))).status).toBe(401);
  });

  it('accepts the configured key', async () => {
    expect((await get(KEY)).status).toBe(200);
  });

  it('answers 503, NOT 200, when the integration is not configured', async () => {
    // The failure that matters: a missing variable must turn the integration off, never
    // open it. A route that starts serving because a secret went missing is the whole
    // reason this middleware exists.
    delete process.env.ERP_INTEGRATION_API_KEY;
    const res = await get(KEY);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('answers 503 with no key and no config, rather than 401', async () => {
    // Order matters: "not configured" is the more accurate answer, and a 401 here would
    // send an integrator hunting for a key problem that does not exist.
    delete process.env.ERP_INTEGRATION_API_KEY;
    expect((await get()).status).toBe(503);
  });
});

describe('what the ERP receives', () => {
  it('returns the same figure as getPlatformRevenue, not its own arithmetic', async () => {
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    const expected = await getPlatformRevenue();

    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.total_mrr).toBe(expected.total_mrr);
    expect(res.body.data.by_plan).toEqual(expected.by_plan);
    expect(res.body.data.currency).toBe('NGN');
  });

  it('divides an annual subscription into a monthly figure', async () => {
    await subscribe(I.schoolA, 'enterprise', 'annual', '1200000.00');
    const res = await get(KEY);
    expect(res.body.data.total_mrr).toBe(100000);
  });

  it('excludes a demo school — a fixture tenant is not revenue', async () => {
    await pool.query(`UPDATE schools SET is_demo = true WHERE id = $1`, [I.schoolA]);
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    expect((await get(KEY)).body.data.total_mrr).toBe(0);
  });

  it('excludes a suspended school — not billing this month', async () => {
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    await pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [I.schoolA]);
    expect((await get(KEY)).body.data.total_mrr).toBe(0);
  });

  it('carries an as_of timestamp, so a stale copy is distinguishable from a fresh read', async () => {
    const res = await get(KEY);
    expect(Date.parse(res.body.data.as_of)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('returns zero rather than erroring when nothing is subscribed', async () => {
    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.total_mrr).toBe(0);
    expect(res.body.data.by_plan).toHaveLength(3);
  });

  it('exposes no school names or identifiers — aggregate only', async () => {
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    const body = JSON.stringify((await get(KEY)).body);
    expect(body).not.toContain('School A');
    expect(body).not.toContain(I.schoolA);
  });
});
