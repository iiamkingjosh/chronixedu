/**
 * Promotions do what the screen says (audit, 8 Oct 2026, finding 8).
 *
 * - Listing a session's students returned every student of the school, enrolled in it or not, so the
 *   Promotion Manager offered to promote children who were never in that session.
 * - promote-bulk took any student and any from-session: a student not in the session being promoted
 *   from was enrolled in the new one all the same.
 * - "Promoted" was a tick beside the student's current class, so a run with every box ticked
 *   "promoted" each child into the class they were already in. A promotion now has to name a
 *   different class.
 * - Two runs at once could both find a student not yet enrolled and enrol them twice (there is no
 *   unique constraint on (student, session)). Each student is now locked while they are promoted.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const NEXT_SESSION = '10000000-0000-4000-8000-000000000081';
const UNENROLLED = '60000000-0000-4000-8000-000000000081';

const promote = (decisions: object[], from = I.sessionA) =>
  request(app).post(`${base}/students/promote-bulk`).set('Authorization', tokens.principalA())
    .send({ from_session_id: from, to_session_id: NEXT_SESSION, decisions });
const enrolments = async (studentId: string) => (await pool.query<{ class_id: string }>(
  `SELECT class_id FROM student_classes WHERE student_id = $1 AND session_id = $2`, [studentId, NEXT_SESSION])).rows;

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1, $2, '2027/2028', '2027-09-13', '2028-07-21', false)`, [NEXT_SESSION, I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ('39000000-0000-4000-8000-000000000081', $1, 'unenrolled@test', 'x', 'student', 'Not', 'Enrolled', true, 'subject', false)`, [I.schoolA]);
  await pool.query(
    `INSERT INTO students (id, school_id, user_id, admission_no) VALUES ($1, $2, '39000000-0000-4000-8000-000000000081', 'ADM-81')`,
    [UNENROLLED, I.schoolA]);
});
afterAll(() => pool.end());

it("listing a session's students lists those enrolled in it, and only them", async () => {
  const res = await request(app).get(`${base}/students`).set('Authorization', tokens.principalA()).query({ session_id: I.sessionA, limit: 100 });
  expect(res.status).toBe(200);
  const ids = res.body.data.map((s: { id: string }) => s.id).sort();
  expect(ids).toEqual([I.s1, I.s2, I.s3OtherClass].sort());

  // The registrar's own list (no session named) still shows a student with no class this session.
  const all = await request(app).get(`${base}/students`).set('Authorization', tokens.principalA()).query({ limit: 100 });
  expect(all.body.data.map((s: { id: string }) => s.id)).toContain(UNENROLLED);
});

it('promotes a student into a different class, and repeats one in the same class', async () => {
  const res = await promote([
    { student_id: I.s1, class_id: I.jss3b, decision: 'promoted' },
    { student_id: I.s2, class_id: I.jss2a, decision: 'repeat' },
  ]);
  expect(res.status).toBe(201);
  expect(res.body.data.results.map((r: { status: string }) => r.status)).toEqual(['enrolled', 'enrolled']);
  expect(await enrolments(I.s1)).toEqual([{ class_id: I.jss3b }]);
  expect(await enrolments(I.s2)).toEqual([{ class_id: I.jss2a }]);
});

it('a "promotion" into the class the student is already in is refused, by name', async () => {
  const res = await promote([{ student_id: I.s1, class_id: I.jss2a, decision: 'promoted' }]);
  expect(res.status).toBe(201);
  expect(res.body.data.results[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/same class/i) });
  expect(await enrolments(I.s1)).toEqual([]);
});

it('a student not in the session being promoted from is not enrolled in the next', async () => {
  const res = await promote([{ student_id: UNENROLLED, class_id: I.jss3b, decision: 'promoted' }]);
  expect(res.body.data.results[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not in/i) });
  expect(await enrolments(UNENROLLED)).toEqual([]);
});

it("refuses a from-session of another school, or the same session twice", async () => {
  const other = await promote([{ student_id: I.s1, class_id: I.jss3b, decision: 'promoted' }], I.sessionB);
  expect(other.status).toBe(404);
  const same = await request(app).post(`${base}/students/promote-bulk`).set('Authorization', tokens.principalA())
    .send({ from_session_id: NEXT_SESSION, to_session_id: NEXT_SESSION, decisions: [{ student_id: I.s1, class_id: I.jss3b, decision: 'promoted' }] });
  expect(same.status).toBe(400);
  expect(await enrolments(I.s1)).toEqual([]);
});

it('two runs at once enrol a student once', async () => {
  const decision = [{ student_id: I.s1, class_id: I.jss3b, decision: 'promoted' }];
  const [a, b] = await Promise.all([promote(decision), promote(decision)]);
  const statuses = [...a.body.data.results, ...b.body.data.results].map((r: { status: string }) => r.status).sort();
  expect(statuses).toEqual(['enrolled', 'skipped']);
  expect(await enrolments(I.s1)).toHaveLength(1);
});
