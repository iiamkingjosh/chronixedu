import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import assignmentsRouter from '../src/routes/assignments';
import { errorHandler } from '../src/middleware/errorHandler';

const SCHOOL_ID  = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const CLASS_ID   = '7a4dded1-ded1-4022-abde-a32d03cd359e';
const SUBJECT_ID = '9ddb5e1d-c3ce-4205-ad0e-9ec584656e2d';
const SESSION_ID = 'e3e62132-16e4-4c1c-ad8b-9118579323c5';
const TEACHER_ID = '37a19d2d-fa5d-45d3-9dc1-5ea1875ef3e0';

const app = express();
app.use(express.json());
app.use('/api/schools', assignmentsRouter);
app.use(errorHandler);

function makeToken(role: string, schoolId: string, userId: string) {
  return jwt.sign(
    { user_id: userId, role, school_id: schoolId, email: 'student.test@chronixedu.com' },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
}

describe('Assignment deadline — submitting after due_date is rejected', () => {
  const suffix = randomUUID().slice(0, 8);

  let studentUserId: string;
  let studentId: string;
  let assignmentId: string;

  beforeAll(async () => {
    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
       VALUES ($1, $2, 'test-hash', 'student', 'Late', 'Submitter')
       RETURNING id`,
      [SCHOOL_ID, `late-student-${suffix}@chronixedu-test.com`]
    );
    studentUserId = studentUserResult.rows[0].id;

    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [SCHOOL_ID, studentUserId, `TEST-LATE-${suffix}`]
    );
    studentId = studentResult.rows[0].id;

    await pool.query(
      `INSERT INTO student_classes (student_id, class_id, session_id) VALUES ($1, $2, $3)`,
      [studentId, CLASS_ID, SESSION_ID]
    );

    const assignmentResult = await pool.query<{ id: string }>(
      `INSERT INTO assignments (school_id, class_id, subject_id, teacher_id, title, description, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [SCHOOL_ID, CLASS_ID, SUBJECT_ID, TEACHER_ID, 'Past-due Assignment', null, '2020-01-01']
    );
    assignmentId = assignmentResult.rows[0].id;
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM assignment_submissions WHERE assignment_id = $1`, [assignmentId]);
    await pool.query(`DELETE FROM assignments WHERE id = $1`, [assignmentId]);
    await pool.query(`DELETE FROM student_classes WHERE student_id = $1`, [studentId]);
    await pool.query(`DELETE FROM students WHERE id = $1`, [studentId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [studentUserId]);
    await pool.end();
  }, 20000);

  it('rejects a submission to an assignment whose due_date has passed', async () => {
    const studentToken = makeToken('student', SCHOOL_ID, studentUserId);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/assignments/${assignmentId}/submissions`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('PAST_DUE');

    const submissionResult = await pool.query(
      `SELECT id FROM assignment_submissions WHERE assignment_id = $1 AND student_id = $2`,
      [assignmentId, studentId]
    );
    expect(submissionResult.rows).toHaveLength(0);
  });
});
