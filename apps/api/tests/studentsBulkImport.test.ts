import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

jest.setTimeout(30000);

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';

import pool from '../src/db/client';
import studentsRouter from '../src/routes/students';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/schools', verifyToken);
app.use('/api/schools', studentsRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function xlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

describe('POST /:schoolId/students/bulk-import/preview', () => {
  let schoolId: string;
  let registrarToken: string;
  let teacherToken: string;
  let existingTeacherEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Bulk Import Preview Test School', `test-bulk-preview-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING id, email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    existingTeacherEmail = teacherResult.rows[0].email;
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  it('rejects a teacher with 403', async () => {
    const buffer = await xlsxBuffer(['First Name', 'Last Name'], [['Ada', 'Bello']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .attach('file', buffer, 'students.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid row as "valid" and writes nothing to the database', async () => {
    const email = `new-student-${randomUUID()}@test.com`;
    const buffer = await xlsxBuffer(['First Name', 'Last Name', 'Email'], [['Ada', 'Bello', email]]);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(res.body.data.rows[0].status).toBe('valid');

    const row = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    expect(row.rows).toHaveLength(0);
  });

  it('previews a row with a student email conflict as "error"', async () => {
    const buffer = await xlsxBuffer(['First Name', 'Last Name', 'Email'], [['Existing', 'Teacher', existingTeacherEmail]]);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('already registered');
  });

  it('rejects a file with no recognizable header row', async () => {
    const buffer = await xlsxBuffer(['Wrong Column'], [['x']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a file with more than 200 rows', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => [`Student${i}`, 'Test']);
    const buffer = await xlsxBuffer(['First Name', 'Last Name'], rows);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'students.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});

describe('POST /:schoolId/students/bulk-import/commit', () => {
  let schoolId: string;
  let registrarToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Bulk Import Commit Test School', `test-bulk-commit-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-commit-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const teacherResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING id, email`,
      [schoolId, `teacher-commit-${randomUUID()}@test.com`]
    );
    teacherToken = makeToken(teacherResult.rows[0].id, 'teacher', schoolId, teacherResult.rows[0].email);
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM parent_students WHERE student_id IN (SELECT id FROM students WHERE school_id = $1)`, [schoolId]);
    await pool.query(`DELETE FROM audit_logs WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(token: string, buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/preview`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, 'students.xlsx');
    return res.body.data.rows;
  }

  it('rejects a teacher with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ rows: [] });
    expect(res.status).toBe(403);
  });

  it('creates students and a new parent, sets the fixed password, and returns a downloadable results file', async () => {
    const studentEmail = `commit-student-${randomUUID()}@test.com`;
    const parentEmail = `commit-parent-${randomUUID()}@test.com`;
    const buffer = await xlsxBuffer(
      ['First Name', 'Last Name', 'Email', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Relationship'],
      [['Ada', 'Bello', studentEmail, 'Bisi', 'Bello', parentEmail, 'Mother']]
    );
    const rows = await preview(registrarToken, buffer);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.failed).toBe(0);
    expect(typeof res.body.data.download_base64).toBe('string');

    const studentRow = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE email = $1`, [studentEmail]);
    expect(studentRow.rows).toHaveLength(1);

    expect(bcrypt.compareSync('Password2$', studentRow.rows[0].password_hash)).toBe(true);

    const parentRow = await pool.query(`SELECT id FROM users WHERE email = $1 AND role = 'parent'`, [parentEmail]);
    expect(parentRow.rows).toHaveLength(1);
  });

  it('reuses an existing parent by email instead of creating a duplicate, for two siblings in the same file', async () => {
    const sharedParentEmail = `shared-parent-${randomUUID()}@test.com`;
    const buffer = await xlsxBuffer(
      ['First Name', 'Last Name', 'Email', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Relationship'],
      [
        ['Sibling', 'One', `sib1-${randomUUID()}@test.com`, 'Shared', 'Parent', sharedParentEmail, 'Father'],
        ['Sibling', 'Two', `sib2-${randomUUID()}@test.com`, 'Shared', 'Parent', sharedParentEmail, 'Father'],
      ]
    );
    const rows = await preview(registrarToken, buffer);

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);

    const parentRows = await pool.query(`SELECT id FROM users WHERE email = $1`, [sharedParentEmail]);
    expect(parentRows.rows).toHaveLength(1); // one parent account, not two
  });

  it('does not roll back other rows when one row fails at commit time', async () => {
    const goodEmail = `good-${randomUUID()}@test.com`;
    const conflictEmail = `will-conflict-${randomUUID()}@test.com`;

    // Pre-create a user with conflictEmail directly in the DB, AFTER preview
    // would have run, to simulate a race between preview and commit.
    const buffer = await xlsxBuffer(
      ['First Name', 'Last Name', 'Email'],
      [['Good', 'Row', goodEmail], ['Conflict', 'Row', conflictEmail]]
    );
    const rows = await preview(registrarToken, buffer);

    await pool.query(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Snuck', 'In', 'subject')`,
      [schoolId, conflictEmail]
    );

    const res = await request(app)
      .post(`/api/schools/${schoolId}/students/bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.failed).toBe(1);

    const goodRow = await pool.query(`SELECT id FROM users WHERE email = $1`, [goodEmail]);
    expect(goodRow.rows).toHaveLength(1);
  });
});

// Closes the shared pg pool once, after every describe block in this file has
// finished — closing it inside an individual describe's afterAll would break
// any sibling describe block that still needs to query the database.
afterAll(async () => {
  await pool.end();
});
