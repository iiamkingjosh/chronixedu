/**
 * Attendance on a day of a term nobody has made current (audit, 8 Oct 2026, F16).
 *
 * Attendance finds its term by the date. When the next term's dates had begun but the principal
 * had not yet made it current or carried the teaching roster into it, every teacher was told
 * "You are not assigned to this class for the selected term", which read as a mistake about the
 * teacher. The cause was the term, and only the principal could fix it. The refusal now says so.
 */
import express from 'express';
import request from 'supertest';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import attendanceRoutes from '../routes/attendance';
import { seed, tokens, IDS as I, pool } from './helpers';

const app = express();
app.use(express.json());
app.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, attendanceRoutes);
app.use(errorHandler);

let secondTerm: string;
const mark = (date: string) => request(app).post(`/api/schools/${I.schoolA}/attendance/mark`).set('Authorization', tokens.math())
  .send({ class_id: I.jss2a, date, entries: [{ student_id: I.s1, status: 'present' }] });

beforeEach(async () => {
  await seed();
  secondTerm = (await pool.query<{ id: string }>(
    `INSERT INTO terms (session_id, school_id, name, start_date, end_date, is_current)
     VALUES ($1, $2, 'Second Term', '2027-01-05', '2027-04-02', false) RETURNING id`, [I.sessionA, I.schoolA])).rows[0].id;
});
afterAll(() => pool.end());

it('a day of a term not yet made current says the term is not active, and who can fix it', async () => {
  // Control: the same teacher, the same class, a day of the current term.
  expect((await mark('2026-10-07')).status).toBe(201);

  const res = await mark('2027-01-11');
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe('TERM_NOT_ACTIVE');
  expect(res.body.error.message).toContain('Second Term');
  expect(res.body.error.message).toMatch(/principal/i);
  expect((await pool.query(`SELECT 1 FROM attendance WHERE term_id = $1`, [secondTerm])).rowCount).toBe(0);
});

it('once the term is current, a teacher without an assignment in it is told that instead', async () => {
  await pool.query(`UPDATE terms SET is_current = false WHERE id = $1`, [I.termA]);
  await pool.query(`UPDATE terms SET is_current = true WHERE id = $1`, [secondTerm]);

  const res = await mark('2027-01-11');
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('NOT_ASSIGNED');
});

it('a teacher assigned in the coming term may mark it before it is made current', async () => {
  await pool.query(
    `INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id) VALUES ($1, $2, $3, $4, $5)`,
    [I.mathTeacher, I.jss2a, I.math, secondTerm, I.schoolA]);
  expect((await mark('2027-01-11')).status).toBe(201);
});
