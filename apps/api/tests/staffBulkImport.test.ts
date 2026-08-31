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
import usersRouter from '../src/routes/users';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/schools', verifyToken);
app.use('/api/schools', usersRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function xlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Staff');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Email', 'First Name', 'Last Name', 'Role', 'Title', 'Phone', 'Teaching Mode'];

describe('POST /:schoolId/staff-bulk-import/preview', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;
  let existingEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Staff Bulk Preview Test School', `test-staff-preview-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject') RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const existingResult = await pool.query<{ email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject') RETURNING email`,
      [schoolId, `existing-${randomUUID()}@test.com`]
    );
    existingEmail = existingResult.rows[0].email;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    // pool is NOT closed here — Task 4 adds a sibling describe block below
    // that still needs it. A single top-level afterAll closes it once.
  }, 30000);

  it('rejects a registrar with 403 (matches the single-item staff-creation route\'s gate)', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['a@example.com', 'A', 'One', 'teacher', '', '', 'class']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid teacher row and flags a row whose email already exists', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['new-teacher@example.com', 'New', 'Teacher', 'teacher', '', '', 'class'],
      [existingEmail, 'Existing', 'Person', 'registrar', '', '', ''],
    ]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 2, valid: 1, invalid: 1 });
    const failedRow = res.body.data.rows.find((r: { status: string }) => r.status === 'error');
    expect(failedRow.errors[0]).toContain('already registered to an existing teacher account');
  });

  it('rejects a row with role=parent outright', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['x@example.com', 'X', 'Y', 'parent', '', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('Role must be one of');
  });

  it('accepts a .csv upload', async () => {
    const csv = 'Email,First Name,Last Name,Role,Title,Phone,Teaching Mode\ncsv-user@example.com,C,User,bursar,,,\n';
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', Buffer.from(csv), 'staff.csv');
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
  });

  it('rejects a file missing a required column', async () => {
    const buffer = await xlsxBuffer(['Email', 'First Name'], [['a@example.com', 'A']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a workbook with more than 50 rows', async () => {
    const manyRows = Array.from({ length: 51 }, (_, i) => [`user${i}@example.com`, 'A', 'One', 'teacher', '', '', 'class']);
    const buffer = await xlsxBuffer(HEADERS, manyRows);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});

describe('POST /:schoolId/staff-bulk-import/commit', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Staff Bulk Commit Test School', `test-staff-commit-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject') RETURNING id, email`,
      [schoolId, `principal-commit-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject') RETURNING id, email`,
      [schoolId, `registrar-commit-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);
  }, 30000);

  afterAll(async () => {
    // The commit route writes audit_logs rows referencing users in this
    // school (see studentsBulkImport.test.ts for the identical precedent) —
    // those must be deleted before the users themselves, or the FK
    // constraint audit_logs_user_id_fkey blocks the DELETE below.
    await pool.query(`DELETE FROM audit_logs WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'staff.xlsx');
    return res.body.data;
  }

  it('rejects a registrar with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ rows: [] });
    expect(res.status).toBe(403);
  });

  it('creates a valid teacher row end-to-end (Supabase Auth + local DB row)', async () => {
    const email = `e2e-teacher-${randomUUID()}@example.com`;
    const buffer = await xlsxBuffer(HEADERS, [[email, 'E2E', 'Teacher', 'teacher', 'Mr.', '', 'class']]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(0);
    expect(typeof commit.body.data.download_base64).toBe('string');

    const dbRow = await pool.query<{ role: string; teacher_mode: string; must_change_password: boolean; password_hash: string }>(
      `SELECT role, teacher_mode, must_change_password, password_hash FROM users WHERE school_id = $1 AND email = $2`,
      [schoolId, email]
    );
    expect(dbRow.rows).toHaveLength(1);
    expect(dbRow.rows[0]).toMatchObject({ role: 'teacher', teacher_mode: 'class' });
    expect(dbRow.rows[0].must_change_password).toBe(true);
    expect(bcrypt.compareSync('Password2$', dbRow.rows[0].password_hash)).toBe(true);
  }, 30000);

  it('does not stop the batch when one row fails validation at commit time', async () => {
    const goodEmail = `e2e-good-${randomUUID()}@example.com`;
    const buffer = await xlsxBuffer(HEADERS, [
      [goodEmail, 'Good', 'One', 'registrar', '', '', ''],
      ['not-an-email', 'Bad', 'Two', 'bursar', '', '', ''],
    ]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 2, valid: 1, invalid: 1 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(1);

    const dbRow = await pool.query(`SELECT id FROM users WHERE school_id = $1 AND email = $2`, [schoolId, goodEmail]);
    expect(dbRow.rows).toHaveLength(1);
  }, 30000);

  it('re-validates every row server-side and ignores a forged "valid" status from the client', async () => {
    // A dishonest client could hand-craft a commit request that skips
    // /preview entirely and claims status: 'valid'/errors: [] on a row whose
    // underlying data is actually invalid. The commit route must re-derive
    // validity itself (via runFullStaffValidation) rather than trusting this
    // client-supplied label — this is the core security property the whole
    // "commit always re-validates" design rests on.
    const forgedRow = {
      row_number: 1,
      status: 'valid',
      errors: [],
      staff: {
        row_number: 1,
        email: 'not-an-email',
        first_name: 'Forged',
        last_name: 'Status',
        role: 'teacher',
        title: null,
        phone: null,
        teacher_mode: 'class',
      },
    };

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/staff-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ rows: [forgedRow] });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(0);
    expect(commit.body.data.failed).toBe(1);

    const dbRow = await pool.query(`SELECT id FROM users WHERE school_id = $1 AND email = $2`, [schoolId, 'not-an-email']);
    expect(dbRow.rows).toHaveLength(0);
  }, 30000);
});

// Closes the shared pg pool once, after every describe block in this file has
// finished — closing it inside an individual describe's afterAll would break
// any sibling describe block that still needs to query the database.
afterAll(async () => {
  await pool.end();
});
