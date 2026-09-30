/**
 * Platform billing counts CURRENTLY ENROLLED students (migration 045).
 *
 * 044 derived amount_naira from COUNT(*) FROM students — everyone ever enrolled, a number
 * that can only grow. The billable count is now students with a student_classes row in the
 * school's current academic session, each counted once. Every test that asserts an amount
 * establishes the non-zero state first (doctrine 16); the ones that assert "unchanged"
 * assert what it was before.
 *
 * The seed enrols three of School A's students in its current session (sessionA); School B
 * has one student and no enrolment. Rate ₦800/student throughout, so School A bills ₦2,400.
 */
import request from 'supertest';
import express from 'express';
import { seed, IDS as I, pool, token } from './helpers';
import superAdminRouter from '../routes/superAdmin';
import { errorHandler } from '../middleware/errorHandler';

/** Ids under a prefix the seed never uses. */
const id = (prefix: string, n: number) => `d${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// helpers.buildApp() mounts the tenant routers only; the super-admin router carries its
// own guard on every route, so it mounts bare, as index.ts mounts it.
const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use(errorHandler);
const SA = 'a5a00000-0000-4000-8000-000000000001';
const sa = () => token(SA, 'super_admin', I.schoolA);
const RATE_KOBO = 80_000; // ₦800 per student

beforeEach(async () => {
  await seed();
  // platform_audit_logs.platform_admin_id references users, so the super_admin must exist.
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, NULL, 'sa@test', 'x', 'super_admin', 'Super', 'Admin', true, 'subject', false)`,
    [SA]
  );
});
afterAll(async () => { await pool.end(); });

const setRate = (kobo = RATE_KOBO) =>
  pool.query(`INSERT INTO platform_pricing_config (price_per_student_kobo) VALUES ($1)
              ON CONFLICT (id) DO UPDATE SET price_per_student_kobo = EXCLUDED.price_per_student_kobo`, [kobo]);
const clearRate = () => pool.query(`DELETE FROM platform_pricing_config`);
const amountOf = async (schoolId: string): Promise<string | undefined> =>
  (await pool.query<{ amount_naira: string }>(`SELECT amount_naira FROM platform_subscriptions WHERE school_id = $1`, [schoolId])).rows[0]?.amount_naira;
const create = (body: object) => request(app).post('/api/super-admin/subscriptions').set('Authorization', sa()).send(body);
const patch = (subId: string, body: object) => request(app).patch(`/api/super-admin/subscriptions/${subId}`).set('Authorization', sa()).send(body);
const preview = (schoolId: string) => request(app).get(`/api/super-admin/schools/${schoolId}/billing-preview`).set('Authorization', sa());
const paid = (schoolId: string) => ({ school_id: schoolId, plan: 'basic', billing_cycle: 'monthly' });

/** A student on School A's roll; enrolled in a class for a session only when asked. */
async function addStudent(n: number, enrol?: { classId: string; sessionId: string }) {
  const uid = id('0', n);
  const sid = id('1', n);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, $3, 'x', 'student', $4, 'Test', true, 'subject', false)`,
    [uid, I.schoolA, `${uid}@test`, `Student${n}`]
  );
  await pool.query(`INSERT INTO students (id, school_id, user_id, admission_no) VALUES ($1, $2, $3, $4)`, [sid, I.schoolA, uid, `ADM-${n}`]);
  if (enrol) {
    await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [sid, enrol.classId, enrol.sessionId]);
  }
  return sid;
}

const NEXT_SESSION = id('2', 7);
async function addSession(schoolId: string, isCurrent: boolean) {
  await pool.query(
    `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current) VALUES ($1, $2, '2027/2028', '2027-09-01', '2028-07-31', $3)`,
    [NEXT_SESSION, schoolId, isCurrent]
  );
}

describe('who is billable', () => {
  it('a student enrolled in the current session counts; one on the roll but not enrolled does not', async () => {
    await setRate();
    await addStudent(40); // on the roll (a students row), never enrolled — 044 billed this one
    await addSession(I.schoolA, false);
    await addStudent(41, { classId: I.jss2a, sessionId: NEXT_SESSION }); // enrolled only in a session that is not current
    const res = await create(paid(I.schoolA));
    expect(res.status).toBe(201);
    expect(res.body.data.amount_naira).toBe('2400.00'); // 3 enrolled × ₦800; 044 said 5 × ₦800
    expect(await amountOf(I.schoolA)).toBe('2400.00');
  });

  it('a student with two student_classes rows in one session counts once', async () => {
    await setRate();
    // student_classes has no unique constraint on (student_id, session_id): a mid-session
    // move between classes leaves two rows. COUNT(DISTINCT) is what keeps this at 3.
    await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [I.s1, I.jss3b, I.sessionA]);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM student_classes WHERE student_id = $1 AND session_id = $2`, [I.s1, I.sessionA]);
    expect(rows[0].n).toBe(2); // the precondition: two rows, one student
    const res = await create(paid(I.schoolA));
    expect(res.body.data.amount_naira).toBe('2400.00');
  });

  it('withdrawing an enrolment recomputes the amount', async () => {
    await setRate();
    await create(paid(I.schoolA));
    expect(await amountOf(I.schoolA)).toBe('2400.00');
    await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [I.s3OtherClass]);
    expect(await amountOf(I.schoolA)).toBe('1600.00');
  });

  it('enrolling a student recomputes the amount', async () => {
    await setRate();
    await create(paid(I.schoolA));
    expect(await amountOf(I.schoolA)).toBe('2400.00');
    await addStudent(42, { classId: I.jss2a, sessionId: I.sessionA });
    expect(await amountOf(I.schoolA)).toBe('3200.00');
  });
});

describe('session rollover', () => {
  it('rolling the current session to a new one recomputes the amount from the new roll', async () => {
    await setRate();
    await create(paid(I.schoolA));
    await addSession(I.schoolA, false);
    // Only s1 carries over. Not yet current, so nothing changes.
    await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [I.s1, I.jss2a, NEXT_SESSION]);
    expect(await amountOf(I.schoolA)).toBe('2400.00');
    // The activate route's order: the old session steps down, then the new one becomes
    // current (one_current_session allows at most one).
    await pool.query(`UPDATE academic_sessions SET is_current = FALSE WHERE id = $1`, [I.sessionA]);
    await pool.query(`UPDATE academic_sessions SET is_current = TRUE WHERE id = $1`, [NEXT_SESSION]);
    expect(await amountOf(I.schoolA)).toBe('800.00');
  });
});

describe('no current session — decided in migration 045', () => {
  it('an update keeps the last computed amount rather than zeroing it', async () => {
    await setRate();
    const created = await create(paid(I.schoolA));
    expect(await amountOf(I.schoolA)).toBe('2400.00'); // the non-zero state this must keep
    await pool.query(`UPDATE academic_sessions SET is_current = FALSE WHERE id = $1`, [I.sessionA]);
    const res = await patch(created.body.data.id, { billing_cycle: 'annual' });
    expect(res.status).toBe(200);
    expect(res.body.data.billing_cycle).toBe('annual');
    expect(await amountOf(I.schoolA)).toBe('2400.00');
  });

  it('creating a paid subscription for a school with no current session is refused, not priced at zero', async () => {
    await setRate();
    await pool.query(`UPDATE academic_sessions SET is_current = FALSE WHERE id = $1`, [I.sessionB]);
    const res = await create(paid(I.schoolB));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_CURRENT_SESSION');
    expect(await amountOf(I.schoolB)).toBeUndefined();
  });

  it('zero students enrolled with a session in place is honestly ₦0.00', async () => {
    await setRate();
    const res = await create(paid(I.schoolB)); // sessionB is current, nobody enrolled
    expect(res.status).toBe(201);
    expect(res.body.data.amount_naira).toBe('0.00');
  });
});

describe('the subscription write', () => {
  it('creates a paid subscription without amount_naira and stores rate × billable students', async () => {
    await setRate();
    const res = await create({ school_id: I.schoolA, plan: 'premium', billing_cycle: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.data.amount_naira).toBe('2400.00');
    expect(await amountOf(I.schoolA)).toBe('2400.00');
  });

  it('refuses amount_naira from the caller rather than silently discarding it', async () => {
    await setRate();
    const res = await create({ ...paid(I.schoolA), amount_naira: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error.message.fieldErrors.amount_naira).toBeTruthy();
    expect(await amountOf(I.schoolA)).toBeUndefined();
  });

  it('with no rate configured, a paid subscription answers 409, not 500', async () => {
    const res = await create(paid(I.schoolA));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BILLING_RATE_NOT_CONFIGURED');
  });

  it('with no rate configured, a trial is still created at ₦0.00', async () => {
    const res = await create({ school_id: I.schoolA, plan: 'trial', billing_cycle: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.data.amount_naira).toBe('0.00');
  });

  it('a plan change to a paid plan with no rate configured answers 409, not 500', async () => {
    const created = await create({ school_id: I.schoolA, plan: 'trial', billing_cycle: 'monthly' });
    const res = await patch(created.body.data.id, { plan: 'basic' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BILLING_RATE_NOT_CONFIGURED');
  });
});

describe('enrolment never depends on billing being configured', () => {
  it('a student is enrolled while no rate is configured, the amount keeps its last value, and catches up once a rate exists', async () => {
    await setRate();
    const created = await create(paid(I.schoolA));
    expect(await amountOf(I.schoolA)).toBe('2400.00');
    await clearRate();
    await addStudent(43, { classId: I.jss2a, sessionId: I.sessionA }); // must not throw
    expect(await amountOf(I.schoolA)).toBe('2400.00'); // last computed value, not ₦0
    await setRate();
    await patch(created.body.data.id, { billing_cycle: 'annual' });
    expect(await amountOf(I.schoolA)).toBe('3200.00'); // four enrolled, once something writes
  });

  it('a student row is created while no rate is configured', async () => {
    await create({ school_id: I.schoolA, plan: 'trial', billing_cycle: 'monthly' });
    await expect(addStudent(44)).resolves.toBeTruthy();
  });
});

describe('the billing preview', () => {
  it('reports the number the trigger uses, and says when it cannot price', async () => {
    await setRate();
    let res = await preview(I.schoolA);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      billable_students: 3, students_on_roll: 3, enrolment_note: null,
      current_session_id: I.sessionA, rate_configured: true, price_per_student_kobo: RATE_KOBO, amount_naira: '2400.00',
    });
    await clearRate();
    res = await preview(I.schoolA);
    expect(res.body.data).toMatchObject({ billable_students: 3, rate_configured: false, price_per_student_kobo: null, amount_naira: null });
    await setRate();
    await pool.query(`UPDATE academic_sessions SET is_current = FALSE WHERE id = $1`, [I.sessionA]);
    res = await preview(I.schoolA);
    expect(res.body.data).toMatchObject({ billable_students: 0, current_session_id: null, rate_configured: true, amount_naira: null });
  });
});

describe('a bare number cannot say why it is low: the preview names the reason', () => {
  const note = async (schoolId: string) => (await preview(schoolId)).body.data;

  it('nothing to explain when everyone on the roll is enrolled — established first, so the notes below mean something', async () => {
    const d = await note(I.schoolA);
    expect(d).toMatchObject({ students_on_roll: 3, billable_students: 3, enrolment_note: null });
  });

  it('some_not_enrolled: a student on the roll with no enrolment this session is named, and not billed', async () => {
    await setRate();
    await addStudent(45); // on the roll, never enrolled
    const d = await note(I.schoolA);
    expect(d).toMatchObject({ students_on_roll: 4, billable_students: 3, enrolment_note: 'some_not_enrolled', amount_naira: '2400.00' });
  });

  it('none_enrolled: a roll of students with a current session but no enrolment is ₦0 for THAT reason', async () => {
    await setRate();
    const d = await note(I.schoolB); // one student on the roll, sessionB is current, nobody enrolled
    expect(d).toMatchObject({ students_on_roll: 1, billable_students: 0, enrolment_note: 'none_enrolled', amount_naira: '0.00' });
  });

  it('no_current_session: ₦0 for a different reason, reported as a different note', async () => {
    await pool.query(`UPDATE academic_sessions SET is_current = FALSE WHERE id = $1`, [I.sessionB]);
    const d = await note(I.schoolB);
    expect(d).toMatchObject({ students_on_roll: 1, billable_students: 0, enrolment_note: 'no_current_session', amount_naira: null });
  });

  it('an empty roll with a session is an honest zero, not a problem', async () => {
    await pool.query(`DELETE FROM students WHERE id = $1`, [I.sOtherSchool]);
    const d = await note(I.schoolB);
    expect(d).toMatchObject({ students_on_roll: 0, billable_students: 0, enrolment_note: null });
  });
});

describe('the schools list shows the roll and the billable count side by side', () => {
  const row = async (schoolId: string) => {
    const res = await request(app).get('/api/super-admin/schools?include_demo=true').set('Authorization', sa());
    expect(res.status).toBe(200);
    return (res.body.data.schools as Array<{ id: string; student_count: string; billable_students: number }>).find((x) => x.id === schoolId)!;
  };

  it('agree when everyone is enrolled; diverge when someone is on the roll and not enrolled', async () => {
    const before = await row(I.schoolA);
    expect(Number(before.student_count)).toBe(3);
    expect(before.billable_students).toBe(3);
    await addStudent(46); // on the roll only
    const after = await row(I.schoolA);
    expect(Number(after.student_count)).toBe(4);
    expect(after.billable_students).toBe(3);
  });
});
