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
import rosterRouter from '../src/routes/roster';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/schools', verifyToken);
app.use('/api/schools', rosterRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function workbookBuffer(sheets: { name: string; headers: string[]; rows: (string | number)[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = workbook.addWorksheet(s.name);
    sheet.addRow(s.headers);
    s.rows.forEach(r => sheet.addRow(r));
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const CLASS_HEADERS = ['Name', 'Level', 'Stream', 'Form Teacher Email'];
const SUBJECT_HEADERS = ['Name', 'Code'];
const ASSIGNMENT_HEADERS = ['Teacher Email', 'Class Name', 'Subject Code'];

function fullWorkbook(overrides: Partial<Record<'Classes' | 'Subjects' | 'Teacher Assignments', (string | number)[][]>> = {}) {
  return workbookBuffer([
    { name: 'Classes', headers: CLASS_HEADERS, rows: overrides['Classes'] ?? [] },
    { name: 'Subjects', headers: SUBJECT_HEADERS, rows: overrides['Subjects'] ?? [] },
    { name: 'Teacher Assignments', headers: ASSIGNMENT_HEADERS, rows: overrides['Teacher Assignments'] ?? [] },
  ]);
}

describe('POST /:schoolId/roster-bulk-import/preview', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;
  let teacherEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Roster Bulk Preview Test School', `test-roster-preview-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `registrar-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const teacherResult = await pool.query<{ email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject', FALSE) RETURNING email`,
      [schoolId, `teacher-${randomUUID()}@test.com`]
    );
    teacherEmail = teacherResult.rows[0].email;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM teacher_assignments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM classes WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM subjects WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    // pool is NOT closed here — Task 4 adds a sibling describe block below
    // that still needs it. A single top-level afterAll closes it once, after
    // every describe block in this file has finished.
  }, 30000);

  it('rejects a registrar with 403 (Roster stays principal/super_admin only, unlike Students)', async () => {
    const buffer = await fullWorkbook();
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .attach('file', buffer, 'roster.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid Class row, a valid Subject row, and an Assignment row that cannot resolve yet', async () => {
    const buffer = await fullWorkbook({
      Classes: [['JSS 1A', 'JSS1', '', '']],
      Subjects: [['Mathematics', 'MTH']],
      'Teacher Assignments': [[teacherEmail, 'Some Existing Class', 'ENG']],
    });

    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'roster.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.classes.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(res.body.data.subjects.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    // The assignment row references a class/subject that don't exist yet (this preview
    // call doesn't create them) — correctly reported as an error, proving Assignments
    // never resolve against same-file Classes/Subjects rows per the design decision.
    expect(res.body.data.assignments.summary).toEqual({ total: 1, valid: 0, invalid: 1 });
    expect(res.body.data.assignments.rows[0].errors.some((e: string) => e.includes('does not match an existing class'))).toBe(true);
  });

  it('rejects a file missing the Teacher Assignments sheet entirely', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(CLASS_HEADERS);
    workbook.addWorksheet('Subjects').addRow(SUBJECT_HEADERS);
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', Buffer.from(arrayBuffer), 'roster.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a .csv upload outright', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', Buffer.from('a,b,c'), 'roster.csv');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PARSE_ERROR');
  });

  it('rejects a workbook with more than 300 rows total across all sheets', async () => {
    const manyClasses = Array.from({ length: 301 }, (_, i) => [`Class ${i}`, 'JSS1', '', '']);
    const buffer = await fullWorkbook({ Classes: manyClasses });
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'roster.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});

describe('POST /:schoolId/roster-bulk-import/commit', () => {
  let schoolId: string;
  let principalToken: string;
  let registrarToken: string;
  let teacherEmail: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Roster Bulk Commit Test School', `test-roster-commit-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `principal-commit-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const registrarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'registrar', 'Test', 'Registrar', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `registrar-commit-${randomUUID()}@test.com`]
    );
    registrarToken = makeToken(registrarResult.rows[0].id, 'registrar', schoolId, registrarResult.rows[0].email);

    const teacherResult = await pool.query<{ email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'teacher', 'Existing', 'Teacher', 'subject', FALSE) RETURNING email`,
      [schoolId, `teacher-commit-${randomUUID()}@test.com`]
    );
    teacherEmail = teacherResult.rows[0].email;

    // An active session + term is required for any Teacher Assignment to
    // validate — set one up directly, matching how other integration tests
    // in this repo establish active-term state.
    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2026/2027', NOW(), NOW() + interval '365 days', true) RETURNING id`,
      [schoolId]
    );
    await pool.query(
      `INSERT INTO terms (school_id, session_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, 'First Term', NOW(), NOW() + interval '90 days', true)`,
      [schoolId, sessionResult.rows[0].id]
    );
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM teacher_assignments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM classes WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM subjects WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .attach('file', buffer, 'roster.xlsx');
    return res.body.data;
  }

  it('rejects a registrar with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${registrarToken}`)
      .send({ classes: [], subjects: [], assignments: [] });
    expect(res.status).toBe(403);
  });

  it('creates a class and a subject, then a later import creates an assignment referencing them', async () => {
    const className = `JSS 1A ${randomUUID()}`;
    const subjectCode = `MTH${randomUUID().slice(0, 4).toUpperCase()}`;

    // Pass 1: Classes + Subjects only, matching the two-pass workflow the
    // design spec explicitly chose (Assignments never see same-commit rows).
    const buffer1 = await fullWorkbook({
      Classes: [[className, 'JSS1', '', '']],
      Subjects: [['Mathematics', subjectCode]],
    });
    const data1 = await preview(buffer1);
    const commit1 = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ classes: data1.classes.rows, subjects: data1.subjects.rows, assignments: [] });

    expect(commit1.status).toBe(200);
    expect(commit1.body.data.classes.created).toBe(1);
    expect(commit1.body.data.subjects.created).toBe(1);
    expect(typeof commit1.body.data.download_base64).toBe('string');

    const classRow = await pool.query(`SELECT id FROM classes WHERE school_id = $1 AND name = $2`, [schoolId, className]);
    expect(classRow.rows).toHaveLength(1);

    // Pass 2: now that the class/subject exist, an Assignment referencing
    // them resolves and commits successfully.
    const buffer2 = await fullWorkbook({
      'Teacher Assignments': [[teacherEmail, className, subjectCode]],
    });
    const data2 = await preview(buffer2);
    expect(data2.assignments.summary).toEqual({ total: 1, valid: 1, invalid: 0 });

    const commit2 = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ classes: [], subjects: [], assignments: data2.assignments.rows });

    expect(commit2.status).toBe(200);
    expect(commit2.body.data.assignments.created).toBe(1);

    const assignmentRow = await pool.query(`SELECT id FROM teacher_assignments WHERE school_id = $1`, [schoolId]);
    expect(assignmentRow.rows).toHaveLength(1);
  });

  it('does not roll back other rows when one class row fails at commit time', async () => {
    const goodName = `Good Class ${randomUUID()}`;
    const conflictName = `Conflict Class ${randomUUID()}`;

    const buffer = await fullWorkbook({ Classes: [[goodName, 'JSS1', '', ''], [conflictName, 'JSS1', '', '']] });
    const data = await preview(buffer);

    // Simulate a race: another request creates conflictName between preview and commit.
    await pool.query(
      `INSERT INTO classes (school_id, name, level) VALUES ($1, $2, 'JSS1')`,
      [schoolId, conflictName]
    );

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/roster-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ classes: data.classes.rows, subjects: [], assignments: [] });

    expect(commit.status).toBe(200);
    expect(commit.body.data.classes.created).toBe(1);
    expect(commit.body.data.classes.failed).toBe(1);

    const goodRow = await pool.query(`SELECT id FROM classes WHERE school_id = $1 AND name = $2`, [schoolId, goodName]);
    expect(goodRow.rows).toHaveLength(1);
  });
});

// Closes the shared pg pool once, after every describe block in this file has
// finished — closing it inside an individual describe's afterAll would break
// any sibling describe block that still needs to query the database.
afterAll(async () => {
  await pool.end();
});
