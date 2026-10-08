/**
 * Class notices reach parents, and both they and students see this session's class
 * (audit, 8 Oct 2026; Moses: parents see the class notices teachers post, "Yes").
 *
 * A teacher's class notice (homework, a trip) reached the students and never the parents: a parent's
 * Notices page listed school announcements only, and no route served a parent the class board. And
 * the student's own board was read from their LATEST enrolment, which is last session's class for a
 * student not yet placed this session: they read last year's class notices as current.
 */
import request from 'supertest';
import { buildApp, seed, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const OLD_SESSION = '10000000-0000-4000-8000-0000000000a1';

const notice = (classId: string, title: string) => pool.query(
  `INSERT INTO notices (school_id, class_id, title, body, created_by) VALUES ($1, $2, $3, 'Details', $4)`,
  [I.schoolA, classId, title, I.mathTeacher]);
const titles = (res: request.Response) => res.body.data.map((n: { title: string }) => n.title);

beforeEach(async () => {
  await seed();
  await notice(I.jss2a, 'JSS 2A trip');
  await notice(I.jss3b, 'SSS 1B exam');
});
afterAll(() => pool.end());

it("a parent sees the class notices of their child's class this session, and no other class's", async () => {
  const res = await request(app).get(`${base}/parent/students/${I.s1}/notices`).set('Authorization', tokens.parentA());
  expect(res.status).toBe(200);
  expect(titles(res)).toEqual(['JSS 2A trip']);
});

it("refuses a child who is not the parent's", async () => {
  const res = await request(app).get(`${base}/parent/students/${I.s3OtherClass}/notices`).set('Authorization', tokens.parentA());
  expect(res.status).toBe(403);
});

it('a child with no class this session has no class notices, not last session’s', async () => {
  // s1 moves: last session in SSS 1B, nothing yet this session.
  await pool.query(
    `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current) VALUES ($1, $2, '2025/2026', '2025-09-01', '2026-07-31', false)`,
    [OLD_SESSION, I.schoolA]);
  await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [I.s1]);
  await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id, enrolled_at) VALUES ($1, $2, $3, NOW())`, [I.s1, I.jss3b, OLD_SESSION]);

  const parent = await request(app).get(`${base}/parent/students/${I.s1}/notices`).set('Authorization', tokens.parentA());
  expect(parent.status).toBe(200);
  expect(titles(parent)).toEqual([]);

  const student = await request(app).get(`${base}/student/notices`).set('Authorization', tokens.studentS1());
  expect(student.status).toBe(200);
  expect(titles(student)).toEqual([]);
});

it('the student sees their own class this session', async () => {
  const res = await request(app).get(`${base}/student/notices`).set('Authorization', tokens.studentS1());
  expect(titles(res)).toEqual(['JSS 2A trip']);
});
