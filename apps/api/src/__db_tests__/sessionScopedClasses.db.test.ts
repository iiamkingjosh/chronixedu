/**
 * "Who is in this class" means this session (audit, 8 Oct 2026, F5).
 *
 * Several class lists joined student_classes on the class alone, so a student who was in JSS 2A last
 * session, and has moved on, still appeared in JSS 2A: on its attendance register (and could be marked
 * there), in its homework totals, in its report-card list and in its fee collection figures.
 *
 * Former pupil X was in JSS 2A last session and is in SSS 1B this session. Each list below is shown
 * holding this session's JSS 2A pupils, s1 and s2, before it is shown not holding X.
 */
import express from 'express';
import request from 'supertest';
import { seed, tokens, IDS as I, pool } from './helpers';
import { detectSupportSession } from '../middleware/detectSupportSession';
import { verifyToken, requirePasswordChanged } from '../middleware/auth';
import { requireActiveSchool } from '../middleware/requireActiveSchool';
import { requireWritableSubscription } from '../middleware/requireWritableSubscription';
import { errorHandler } from '../middleware/errorHandler';
import attendanceRoutes from '../routes/attendance';
import { listAssignmentsForSchool, listSubmissionsForAssignment } from '../db/queries/assignments';
import { getReportCardsForClass } from '../db/queries/reportCards';
import { getCollectionSummary } from '../db/queries/fees';
import { getMonthlySummary } from '../db/queries/attendance';

const att = express();
att.use(express.json());
att.use('/api/schools', detectSupportSession, verifyToken, requirePasswordChanged, requireActiveSchool, requireWritableSubscription, attendanceRoutes);
att.use(errorHandler);
const base = `/api/schools/${I.schoolA}`;

const OLD_SESSION = '10000000-0000-4000-8000-0000000000d1';
const X = '60000000-0000-4000-8000-0000000000d1';
const X_USER = '39000000-0000-4000-8000-0000000000d1';

beforeEach(async () => {
  await seed();
  await pool.query(
    `INSERT INTO academic_sessions (id, school_id, name, start_date, end_date, is_current) VALUES ($1, $2, '2025/2026', '2025-09-01', '2026-07-31', false)`,
    [OLD_SESSION, I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, 'former@test', 'x', 'student', 'Former', 'Pupil', true, 'subject', false)`, [X_USER, I.schoolA]);
  await pool.query(`INSERT INTO students (id, school_id, user_id, admission_no) VALUES ($1, $2, $3, 'ADM-D1')`, [X, I.schoolA, X_USER]);
  await pool.query(`INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3), ($1, $4, $5)`,
    [X, I.jss2a, OLD_SESSION, I.jss3b, I.sessionA]);
});
afterAll(() => pool.end());

const ids = (rows: Array<{ student_id: string }>) => rows.map(r => r.student_id).sort();

it("the attendance register lists this session's class, and a former pupil cannot be marked in it", async () => {
  const sheet = await request(att).get(`${base}/attendance/class`).set('Authorization', tokens.math()).query({ class_id: I.jss2a, date: '2026-10-07' });
  expect(sheet.status).toBe(200);
  expect(ids(sheet.body.data.roster)).toEqual([I.s1, I.s2].sort());

  const mark = await request(att).post(`${base}/attendance/mark`).set('Authorization', tokens.math())
    .send({ class_id: I.jss2a, date: '2026-10-07', entries: [{ student_id: X, status: 'absent' }] });
  expect(mark.status).toBe(400);
  expect(mark.body.error.code).toBe('NO_ENROLLED_STUDENTS');
});

it("the monthly summary lists this session's class", async () => {
  const rows = await getMonthlySummary(I.jss2a, I.schoolA, 10, 2026);
  expect(ids(rows)).toEqual([I.s1, I.s2].sort());
});

it("homework totals and submission lists count this session's class", async () => {
  const a = (await pool.query<{ id: string }>(
    `INSERT INTO assignments (school_id, class_id, subject_id, teacher_id, title, due_date) VALUES ($1, $2, $3, $4, 'Essay', '2026-10-20') RETURNING id`,
    [I.schoolA, I.jss2a, I.math, I.mathTeacher])).rows[0].id;
  const [row] = (await listAssignmentsForSchool(I.schoolA)).filter(r => r.id === a);
  expect(row.students_total).toBe(2);
  expect(ids(await listSubmissionsForAssignment(a, I.jss2a))).toEqual([I.s1, I.s2].sort());
});

it("the class's report cards and fee collection are this session's pupils'", async () => {
  for (const sid of [I.s1, X]) {
    await pool.query(`INSERT INTO report_cards (school_id, student_id, term_id, is_published) VALUES ($1, $2, $3, false)`, [I.schoolA, sid, I.termA]);
    await pool.query(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status) VALUES ($1, $2, $3, 1000, 0, 1000, 'unpaid')`,
      [I.schoolA, sid, I.termA]);
  }
  expect(ids(await getReportCardsForClass(I.jss2a, I.termA, I.schoolA))).toEqual([I.s1]);
  const summary = await getCollectionSummary(I.schoolA, I.termA, I.jss2a);
  expect(Number(summary.total_expected)).toBe(1000);
  expect(summary.counts.unpaid).toBe(1);
});
