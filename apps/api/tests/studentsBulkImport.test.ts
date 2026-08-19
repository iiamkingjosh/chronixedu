import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });

jest.setTimeout(30000);

import { randomUUID } from 'crypto';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';

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
    await pool.end();
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
