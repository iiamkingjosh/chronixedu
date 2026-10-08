/**
 * A student's dashboard between terms, and before they are placed this session (audit, 8 Oct 2026).
 *
 * - With no current term the dashboard answered 404 "No active term", which the screen showed as a
 *   red error on the student's home page, every day of every holiday.
 * - A student enrolled last session and not yet this session was shown last session's class as their
 *   class, because the summary fell back to their LATEST enrolment.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const dashboard = () => request(app).get(`/api/schools/${I.schoolA}/student/dashboard`).set('Authorization', tokens.studentS1());
const OLD_SESSION = '10000000-0000-4000-8000-0000000000b1';

beforeEach(async () => { await seed(); });
afterAll(() => pool.end());

it('with a current term: the class and the term are this session’s', async () => {
  const res = await dashboard();
  expect(res.status).toBe(200);
  expect(res.body.data.student.class_name).toBe('JSS 2A');
  expect(res.body.data.term).toEqual({ id: I.termA, name: 'First Term' });
});

it('between terms: 200, with no term, rather than an error', async () => {
  await pool.query(`UPDATE terms SET is_current = false WHERE school_id = $1`, [I.schoolA]);
  const res = await dashboard();
  expect(res.status).toBe(200);
  expect(res.body.data.term).toBeNull();
  expect(res.body.data.academic).toBeNull();
  expect(res.body.data.attendance).toBeNull();
  expect(res.body.data.student.class_name).toBe('JSS 2A');
});

it("not yet placed this session: no class, not last session's", async () => {
  await pool.query(
    `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current) VALUES ($1, $2, '2025/2026', '2025-09-01', '2026-07-31', false)`,
    [OLD_SESSION, I.schoolA]);
  await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [I.s1]);
  await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`, [I.s1, I.jss3b, OLD_SESSION]);

  const res = await dashboard();
  expect(res.status).toBe(200);
  expect(res.body.data.student.class_name).toBeNull();
});
