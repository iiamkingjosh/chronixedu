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

/**
 * Since migrations 044/045 amount_naira is DERIVED — the per-student rate × the students
 * enrolled in the school's current session — and the database recomputes it on every
 * write. A subscription's amount is therefore chosen through the rate and the enrolment,
 * never typed. The seed enrols THREE of School A's students in its current session and
 * none of School B's, so School A at rate R bills 3R kobo a cycle.
 */
const A_ENROLLED = 3;
async function setRate(kobo: number) {
  await pool.query(
    `INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET price_per_student_kobo = EXCLUDED.price_per_student_kobo`,
    [kobo]
  );
}
/** An active subscription for a school; the seed leaves every school without one. */
async function subscribe(schoolId: string, plan: string, cycle: string) {
  await pool.query(
    `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, subscription_status)
     VALUES ($1, $2, $3, 'active')`,
    [schoolId, plan, cycle]
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
    await setRate(1_000_000);
    await subscribe(I.schoolA, 'premium', 'monthly');
    const expected = await getPlatformRevenue();

    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.total_mrr_kobo).toBe(expected.total_mrr_kobo);
    expect(res.body.data.by_plan).toEqual(expected.by_plan);
    expect(res.body.data.currency).toBe('NGN');
    expect(res.body.data.unit).toBe('kobo');
  });

  it('reports kobo, not naira — three students at ₦10,000 is ₦30,000, which is 3,000,000', async () => {
    await setRate(1_000_000);
    await subscribe(I.schoolA, 'premium', 'monthly');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(A_ENROLLED * 1_000_000);
  });

  it('divides an annual subscription into a monthly figure', async () => {
    await setRate(4_000_000); // three students × ₦40,000 = ₦120,000 a year
    await subscribe(I.schoolA, 'enterprise', 'annual');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe((A_ENROLLED * 4_000_000) / 12);
  });

  it('excludes a demo school — a fixture tenant is not revenue', async () => {
    await setRate(1_000_000);
    await subscribe(I.schoolA, 'premium', 'monthly');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(A_ENROLLED * 1_000_000); // counted first
    await pool.query(`UPDATE schools SET is_demo = true WHERE id = $1`, [I.schoolA]);
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(0);
  });

  it('excludes a suspended school — not billing this month', async () => {
    await setRate(1_000_000);
    await subscribe(I.schoolA, 'premium', 'monthly');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(A_ENROLLED * 1_000_000); // counted first
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
    expect(res.body.data.by_plan).toHaveLength(2); // premium, enterprise — trial is never revenue
  });

  it('exposes no school names or identifiers — aggregate only', async () => {
    await setRate(1_000_000);
    await subscribe(I.schoolA, 'premium', 'monthly');
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
    await setRate(66_633); // three students × ₦666.33 = ₦1,998.99
    await subscribe(I.schoolA, 'premium', 'monthly');
    const res = await get(KEY);
    expect(res.body.data.total_mrr_kobo).toBe(199_899);
    // An integer, not a float that happens to print cleanly — the consumer never has to
    // ask which of the two it received.
    expect(Number.isInteger(res.body.data.total_mrr_kobo)).toBe(true);
  });

  it('an annual amount that does not divide by 12 rounds to whole kobo', async () => {
    // Three students × ₦33.33 = ₦99.99/yr = 9,999 kobo / 12 = 833.25 → 833. The old code
    // produced a repeating float here and left the consumer to guess what to do with it.
    await setRate(3_333);
    await subscribe(I.schoolA, 'premium', 'annual');
    expect((await get(KEY)).body.data.total_mrr_kobo).toBe(833);
  });

  it('the parts add up to the total exactly, with awkward amounts in three plans', async () => {
    // `platform_subscriptions` is unique on school_id — one subscription per school — so
    // three plans needs three schools, each with students enrolled in a CURRENT session:
    // School A has three from the seed; School B gets its one student enrolled; School C is
    // built here with two, because no other test needs it. Born dormant, then activated —
    // migration 039 rejects a school created active or activated without an active principal.
    const schoolC = 'c0000000-0000-4000-8000-000000000001';
    const principalC = 'c0000000-0000-4000-8000-000000000002';
    const sessionC = 'c0000000-0000-4000-8000-000000000003';
    const classC = 'c0000000-0000-4000-8000-000000000004';
    const classB = 'c0000000-0000-4000-8000-000000000005';
    await pool.query(`INSERT INTO schools (id, name, slug, is_demo) VALUES ($1, 'School C', 'school-c', FALSE)`, [schoolC]);
    await pool.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
       VALUES ($1, $2, $3, 'x', 'principal', 'PrinC', 'Test', true, 'subject', false)`,
      [principalC, schoolC, `${principalC}@test`]
    );
    await pool.query(`UPDATE schools SET is_active = true WHERE id = $1`, [schoolC]);
    await pool.query(`INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current) VALUES ($1, $2, '2026/2027', '2026-09-01', '2027-07-31', true)`, [sessionC, schoolC]);
    await pool.query(`INSERT INTO classes (id, school_id, name, level) VALUES ($1, $2, 'JSS 1', 'Junior'), ($3, $4, 'JSS 1', 'Junior')`, [classC, schoolC, classB, I.schoolB]);
    for (const n of [51, 52]) {
      const uid = `c0000000-0000-4000-8000-0000000000${n}`;
      const sid = `c0000000-0000-4000-8000-0000000001${n}`;
      await pool.query(
        `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
         VALUES ($1, $2, $3, 'x', 'student', $4, 'Test', true, 'subject', false)`,
        [uid, schoolC, `${uid}@test`, `StudentC${n}`]
      );
      await pool.query(`INSERT INTO students (id, school_id, user_id, admission_no) VALUES ($1, $2, $3, $4)`, [sid, schoolC, uid, `ADM-C${n}`]);
      await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [sid, classC, sessionC]);
    }
    await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [I.sOtherSchool, classB, I.sessionB]);

    await setRate(33_333); // ₦333.33 a student
    await subscribe(I.schoolA, 'premium', 'monthly');    // 3 × 33,333 = 99,999
    await subscribe(I.schoolB, 'enterprise', 'annual');  // 1 × 33,333 / 12 = 2,777.75 → 2,778
    await subscribe(schoolC, 'premium', 'termly');       // 2 × 33,333 / 4 = 16,666.5 → 16,667

    const { data } = (await get(KEY)).body;
    const summed = data.by_plan.reduce((acc: number, p: { mrr_kobo: number }) => acc + p.mrr_kobo, 0);
    // Not "close to" — equal. A consumer reconciling per-plan against the total must not
    // have to allow a tolerance.
    expect(summed).toBe(data.total_mrr_kobo);
    expect(data.total_mrr_kobo).toBe(99_999 + 2_778 + 16_667);
  });

  it('every figure in the payload is an integer', async () => {
    await setRate(3_333_333); // three students × ₦33,333.33 a year → 833,333.25 a month → 833,333
    await subscribe(I.schoolA, 'premium', 'annual');
    const { data } = (await get(KEY)).body;
    const figures = [data.total_mrr_kobo, ...data.by_plan.map((p: { mrr_kobo: number }) => p.mrr_kobo)];
    expect(figures.every(Number.isInteger)).toBe(true);
  });
});
