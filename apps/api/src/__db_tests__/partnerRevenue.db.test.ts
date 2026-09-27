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
    expect(res.body.data.total_mrr_kobo).toBe(expected.total_mrr_kobo);
    expect(res.body.data.by_plan).toEqual(expected.by_plan);
    expect(res.body.data.currency).toBe('NGN');
    expect(res.body.data.unit).toBe('kobo');
  });

  it('reports kobo, not naira — ₦50,000 is 5,000,000', async () => {
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(5_000_000);
  });

  it('divides an annual subscription into a monthly figure', async () => {
    await subscribe(I.schoolA, 'enterprise', 'annual', '1200000.00');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(10_000_000);
  });

  it('excludes a demo school — a fixture tenant is not revenue', async () => {
    await pool.query(`UPDATE schools SET is_demo = true WHERE id = $1`, [I.schoolA]);
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(0);
  });

  it('excludes a suspended school — not billing this month', async () => {
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    await pool.query(`UPDATE schools SET is_active = false WHERE id = $1`, [I.schoolA]);
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(0);
  });

  it('carries an as_of timestamp, so a stale copy is distinguishable from a fresh read', async () => {
    const res = await get(KEY);
    expect(Date.parse(res.body.data.as_of)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('returns zero rather than erroring when nothing is subscribed', async () => {
    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.total_mrr_kobo).toBe(0);
    expect(res.body.data.by_plan).toHaveLength(3);
  });

  it('exposes no school names or identifiers — aggregate only', async () => {
    await subscribe(I.schoolA, 'premium', 'monthly', '50000.00');
    const body = JSON.stringify((await get(KEY)).body);
    expect(body).not.toContain('School A');
    expect(body).not.toContain(I.schoolA);
  });
});

/**
 * The contract is integer kobo because the float version shipped repeating decimals to a
 * billing consumer. Measured against the old code on this same fixture, not reasoned
 * about: a single ₦100.00/year subscription produced
 *
 *   {"total_mrr":8.333333333333334,"currency":"NGN"}
 *
 * where this one produces {"total_mrr_kobo":833,"unit":"kobo"}. The ERP would have had to
 * decide what to do with the tail, and whatever it decided would have been its own
 * rounding rule, applied where nobody here could see it.
 */
describe('the money contract', () => {
  it('a naira amount with kobo in it arrives as whole kobo', async () => {
    await subscribe(I.schoolA, 'basic', 'monthly', '1999.99');
    const res = await get(KEY);
    expect(res.body.data.total_mrr_kobo).toBe(199_999);
    // An integer, not a float that happens to print cleanly — the consumer never has to
    // ask which of the two it received.
    expect(Number.isInteger(res.body.data.total_mrr_kobo)).toBe(true);
  });

  it('an annual amount that does not divide by 12 rounds to whole kobo', async () => {
    // ₦100.00/yr = 10,000 kobo / 12 = 833.33… → 833. The old code produced
    // 8.333333333333334 naira and left the consumer to guess what to do with it.
    await subscribe(I.schoolA, 'basic', 'annual', '100.00');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(833);
  });

  it('the parts add up to the total exactly, with awkward amounts in three plans', async () => {
    // `platform_subscriptions` is unique on school_id — one subscription per school — so
    // three plans needs three schools. schoolC is created here rather than seeded
    // because no other test needs it.
    const schoolC = 'c0000000-0000-4000-8000-000000000001';
    const principalC = 'c0000000-0000-4000-8000-000000000002';
    // Born dormant, then activated — migration 039 rejects a school created active, and
    // rejects activating one with no active principal. Both guards are doing their job
    // here; this is the shape every fixture uses.
    await pool.query(`INSERT INTO schools (id, name, slug) VALUES ($1, 'School C', 'school-c')`, [schoolC]);
    await pool.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
       VALUES ($1, $2, $3, 'x', 'principal', 'PrinC', 'Test', true, 'subject', false)`,
      [principalC, schoolC, `${principalC}@test`]
    );
    await pool.query(`UPDATE schools SET is_active = true WHERE id = $1`, [schoolC]);
    await subscribe(I.schoolA, 'basic', 'monthly', '333.33');
    await subscribe(I.schoolB, 'premium', 'annual', '1000.00');
    await subscribe(schoolC, 'enterprise', 'monthly', '0.01');

    const { data } = (await get(KEY)).body;
    const summed = data.by_plan.reduce((acc: number, p: { mrr_kobo: number }) => acc + p.mrr_kobo, 0);
    // Not "close to" — equal. A consumer reconciling per-plan against the total must not
    // have to allow a tolerance.
    expect(summed).toBe(data.total_mrr_kobo);
    expect(data.total_mrr_kobo).toBe(33_333 + 8_333 + 1);

    await pool.query(`DELETE FROM platform_subscriptions WHERE school_id = $1`, [schoolC]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [principalC]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolC]);
  });

  it('every figure in the payload is an integer', async () => {
    await subscribe(I.schoolA, 'premium', 'annual', '99999.99');
    const { data } = (await get(KEY)).body;
    const figures = [data.total_mrr_kobo, ...data.by_plan.map((p: { mrr_kobo: number }) => p.mrr_kobo)];
    expect(figures.every(Number.isInteger)).toBe(true);
  });
});
