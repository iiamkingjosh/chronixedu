/**
 * Who reads the student list and a student's profile (Batch 9, task 5; Moses, 8 Oct 2026).
 *
 * - The bursar looks students up, read-only, to find a child to invoice (spec decision 3).
 * - A teacher no longer reads the school-wide list or any student's profile (decision 5): a teacher's own classes
 *   come through the class screens. No teacher page called these routes.
 * - Registering and changing a student stay the registrar's and the principal's.
 * - The single-student promote route is gone: no screen called it; Assign Class and Promotions replace it.
 */
import request from 'supertest';
import { buildApp, seed, token, tokens, IDS as I, pool } from './helpers';

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const BURSAR = '30000000-0000-4000-8000-000000000091';
const REGISTRAR = '30000000-0000-4000-8000-000000000092';
const bursar = () => token(BURSAR, 'bursar', I.schoolA);
const registrar = () => token(REGISTRAR, 'registrar', I.schoolA);

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $3, 'bursar@students.test', 'x', 'bursar', 'Bur', 'Sar', true, 'subject', false),
            ($2, $3, 'registrar@students.test', 'x', 'registrar', 'Reg', 'Istrar', true, 'subject', false)`,
    [BURSAR, REGISTRAR, I.schoolA]);
});
afterAll(() => pool.end());

const list = (auth: string) => request(app).get(`${base}/students`).set('Authorization', auth);
const profile = (studentId: string, auth: string) => request(app).get(`${base}/students/${studentId}`).set('Authorization', auth);

it('the bursar reads the list and a profile, and changes nothing', async () => {
  const all = await list(bursar());
  expect(all.status).toBe(200);
  expect(all.body.data.length).toBeGreaterThan(0);
  expect((await profile(I.s1, bursar())).status).toBe(200);

  const edit = await request(app).patch(`${base}/students/${I.s1}`).set('Authorization', bursar()).send({ first_name: 'Changed' });
  expect(edit.status).toBe(403);
  const register = await request(app).post(`${base}/students`).set('Authorization', bursar()).send({});
  expect(register.status).toBe(403);
});

it('a teacher reads neither the list nor a profile; the principal and registrar read both', async () => {
  expect((await list(tokens.math())).status).toBe(403);
  expect((await profile(I.s1, tokens.math())).status).toBe(403);
  for (const auth of [tokens.principalA(), registrar()]) {
    expect((await list(auth)).status).toBe(200);
    expect((await profile(I.s1, auth)).status).toBe(200);
  }
});

it('a parent reads their own child, and only their own; a student reads only themselves', async () => {
  expect((await profile(I.s1, tokens.parentA())).status).toBe(200);
  expect((await profile(I.s2, tokens.parentA())).status).toBe(403);
  expect((await profile(I.s1, tokens.studentS1())).status).toBe(200);
  expect((await profile(I.s2, tokens.studentS1())).status).toBe(403);
});

it('the single-student promote route is gone', async () => {
  const res = await request(app).post(`${base}/students/${I.s1}/promote`).set('Authorization', tokens.principalA())
    .send({ class_id: I.jss3b, session_id: I.sessionA });
  expect(res.status).toBe(404);
  expect((await pool.query(`SELECT 1 FROM student_classes WHERE student_id = $1 AND class_id = $2`, [I.s1, I.jss3b])).rowCount).toBe(0);
});
