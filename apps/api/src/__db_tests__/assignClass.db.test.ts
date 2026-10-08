/**
 * Assign Class (8 Oct 2026). Registration takes a class only optionally and said one could be given later,
 * but the only class route was a correction, which refuses a student with no enrolment: a student registered
 * without a class could never get one. POST /:schoolId/students/:studentId/class gives one, in the current
 * session, recorded in the audit log, and the school's subscription follows (migration 045's trigger).
 * Tested against the real routes and database; every refusal is shown beside a request that succeeds.
 */
import request from 'supertest';
import { pool, seed, IDS as I, buildApp, token, tokens } from './helpers';

const A = I.schoolA;
const REGISTRAR = 'e0e50000-0000-4000-8000-000000000001';
const CALLER_IP = '102.89.44.217';
const app = buildApp();
const registrar = () => token(REGISTRAR, 'registrar', A);

const assign = (studentId: string, classId: string, t = registrar()) =>
  request(app).post(`/api/schools/${A}/students/${studentId}/class`).set('Authorization', t).set('X-Real-IP', CALLER_IP).send({ class_id: classId });
const enrolments = async (studentId: string) => (await pool.query(
  `SELECT class_id, session_id FROM student_classes WHERE student_id = $1`, [studentId])).rows;
const amount = async () => (await pool.query(`SELECT amount_naira FROM platform_subscriptions WHERE school_id = $1`, [A])).rows[0].amount_naira;

/** Resolves once `n` other sessions are waiting on a row lock: a condition read from Postgres, not a sleep. */
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (rows[0].waiting >= n) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`fewer than ${n} sessions ever waited on the lock`);
}

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, must_change_password)
     VALUES ($1, $2, 'registrar-a@test', 'x', 'registrar', 'Registrar', 'A', true, false)`, [REGISTRAR, A]);
  // s2 is registered with no class this session: the student this route exists for.
  await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [I.s2]);
  // A paid subscription, so the bill can be seen to follow the class.
  await pool.query(`INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES (80000) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO platform_subscriptions (school_id, plan, billing_cycle, subscription_status) VALUES ($1, 'premium', 'termly', 'active')`, [A]);
});

afterAll(async () => {
  await pool.end();
});

describe('a student with no class this session', () => {
  it('the registrar assigns one: enrolled in the current session, audited, and billed', async () => {
    expect(await enrolments(I.s2)).toEqual([]);
    expect(await amount()).toBe('1600.00'); // s1 and s3 are billable; s2 is not
    const res = await assign(I.s2, I.jss2a);
    expect(res.status).toBe(201);
    expect(await enrolments(I.s2)).toEqual([{ class_id: I.jss2a, session_id: I.sessionA }]);
    expect(await amount()).toBe('2400.00');
    expect((await pool.query(
      `SELECT user_id, ip_address, new_value FROM audit_logs WHERE action_type = 'STUDENT_CLASS_ASSIGNED'`)).rows)
      .toEqual([{ user_id: REGISTRAR, ip_address: CALLER_IP, new_value: { student_id: I.s2, class_id: I.jss2a, session_id: I.sessionA } }]);
    // And the profile now says so, which is what turns the button into Correct Class.
    const profile = await request(app).get(`/api/schools/${A}/students/${I.s2}`).set('Authorization', registrar());
    expect(profile.body.data.enrollments).toMatchObject([{ class_id: I.jss2a, session_is_current: true }]);
  });

  it('the principal may too', async () => {
    expect((await assign(I.s2, I.jss3b, tokens.principalA())).status).toBe(201);
  });

  it('twice at the same moment: one class, one refusal', async () => {
    // Made to overlap: a third connection holds the student's row until both requests wait on it.
    const holder = await pool.connect();
    let both: request.Response[];
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM students WHERE id = $1 FOR UPDATE`, [I.s2]);
      const sent = Promise.all([assign(I.s2, I.jss2a), assign(I.s2, I.jss3b)]);
      await waitForLockWaiters(2);
      await holder.query('COMMIT');
      both = await sent;
    } finally {
      holder.release();
    }
    expect(both.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await enrolments(I.s2)).toHaveLength(1);
    expect(await amount()).toBe('2400.00');
  });
});

describe('what is refused', () => {
  it('a student who already has a class is pointed to Correct Class, which still works', async () => {
    const res = await assign(I.s1, I.jss3b);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_IN_CLASS');
    expect(await enrolments(I.s1)).toEqual([{ class_id: I.jss2a, session_id: I.sessionA }]);
    const corrected = await request(app).patch(`/api/schools/${A}/students/${I.s1}/class`).set('Authorization', registrar())
      .send({ class_id: I.jss3b, reason: 'Placed in the wrong arm at registration' });
    expect(corrected.status).toBe(200);
  });

  it('a teacher', async () => {
    expect((await assign(I.s2, I.jss2a, tokens.math())).status).toBe(403);
    expect(await enrolments(I.s2)).toEqual([]);
  });

  it('a class from another school', async () => {
    const otherClass = (await pool.query(
      `INSERT INTO classes (school_id, name, level) VALUES ($1, 'JSS 1B', 'Junior') RETURNING id`, [I.schoolB])).rows[0].id;
    const res = await assign(I.s2, otherClass);
    expect(res.status).toBe(404);
    expect(await enrolments(I.s2)).toEqual([]);
  });

  it('a school with no current session', async () => {
    await pool.query(`UPDATE academic_sessions SET is_current = FALSE WHERE school_id = $1`, [A]);
    const res = await assign(I.s2, I.jss2a);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_CURRENT_SESSION');
    expect(await enrolments(I.s2)).toEqual([]);
  });
});
