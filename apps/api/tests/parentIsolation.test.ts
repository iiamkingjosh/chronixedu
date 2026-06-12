import dotenv from 'dotenv';
import path from 'path';

// Must be before any import that reads process.env (pool reads DATABASE_URL at import time)
dotenv.config({ path: path.join(__dirname, '../.env') });

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import pool from '../src/db/client';
import parentRouter from '../src/routes/parent';
import { errorHandler } from '../src/middleware/errorHandler';

const SCHOOL_ID = 'a8f70089-aef1-4f65-a226-4c68d0380285';
const TERM_ID   = '3df9f000-f173-4307-a986-64516372c2a0';

const app = express();
app.use(express.json());
app.use('/api/schools', parentRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function createUser(role: string, email: string, firstName: string, lastName: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name)
     VALUES ($1, $2, 'test-hash', $3, $4, $5)
     RETURNING id`,
    [SCHOOL_ID, email, role, firstName, lastName]
  );
  return result.rows[0].id;
}

async function createStudent(userId: string, admissionNo: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
    [SCHOOL_ID, userId, admissionNo]
  );
  return result.rows[0].id;
}

describe('Parent data isolation — cannot access another parent\'s child', () => {
  const suffix = randomUUID().slice(0, 8);

  let parentAUserId: string;
  let parentBUserId: string;
  let studentAUserId: string;
  let studentBUserId: string;
  let studentAId: string;
  let studentBId: string;

  beforeAll(async () => {
    parentAUserId = await createUser('parent', `parent-a-${suffix}@chronixedu-test.com`, 'Parent', 'A');
    parentBUserId = await createUser('parent', `parent-b-${suffix}@chronixedu-test.com`, 'Parent', 'B');

    studentAUserId = await createUser('student', `student-a-${suffix}@chronixedu-test.com`, 'Student', 'A');
    studentBUserId = await createUser('student', `student-b-${suffix}@chronixedu-test.com`, 'Student', 'B');

    studentAId = await createStudent(studentAUserId, `TEST-A-${suffix}`);
    studentBId = await createStudent(studentBUserId, `TEST-B-${suffix}`);

    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact)
       VALUES ($1, $2, 'mother', TRUE)`,
      [parentAUserId, studentAId]
    );
    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, relationship_type, is_primary_contact)
       VALUES ($1, $2, 'mother', TRUE)`,
      [parentBUserId, studentBId]
    );
  }, 20000);

  afterAll(async () => {
    await pool.query(`DELETE FROM parent_students WHERE parent_id IN ($1, $2)`, [parentAUserId, parentBUserId]);
    await pool.query(`DELETE FROM students WHERE id IN ($1, $2)`, [studentAId, studentBId]);
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3, $4)`, [
      parentAUserId,
      parentBUserId,
      studentAUserId,
      studentBUserId,
    ]);
    await pool.end();
  }, 20000);

  it('Parent A can fetch their own child\'s attendance', async () => {
    const tokenA = makeToken(parentAUserId, 'parent', SCHOOL_ID, `parent-a-${suffix}@chronixedu-test.com`);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/parent/students/${studentAId}/attendance`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('Parent A is forbidden from fetching Parent B\'s child\'s attendance', async () => {
    const tokenA = makeToken(parentAUserId, 'parent', SCHOOL_ID, `parent-a-${suffix}@chronixedu-test.com`);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/parent/students/${studentBId}/attendance`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('Parent A is forbidden from fetching Parent B\'s child\'s snapshot', async () => {
    const tokenA = makeToken(parentAUserId, 'parent', SCHOOL_ID, `parent-a-${suffix}@chronixedu-test.com`);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/parent/students/${studentBId}/snapshot`)
      .query({ term_id: TERM_ID })
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
