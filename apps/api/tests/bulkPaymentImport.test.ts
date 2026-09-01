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
import feesRouter from '../src/routes/fees';
import { verifyToken } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errorHandler';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/schools', verifyToken);
app.use('/api/schools', feesRouter);
app.use(errorHandler);

function makeToken(userId: string, role: string, schoolId: string | null, email: string) {
  return jwt.sign({ user_id: userId, role, school_id: schoolId, email }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

async function xlsxBuffer(headers: string[], rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Payments');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Admission Number', 'Amount', 'Method', 'Payment Date', 'Reference'];

describe('POST /:schoolId/payments-bulk-import/preview', () => {
  let schoolId: string;
  let bursarToken: string;
  let principalToken: string;
  let termId: string;
  let studentAdmissionNo: string;
  let invoiceId: string;
  let studentWithNoInvoiceAdmissionNo: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Payment Bulk Preview Test School', `test-payment-preview-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const bursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Test', 'Bursar', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `bursar-${randomUUID()}@test.com`]
    );
    bursarToken = makeToken(bursarResult.rows[0].id, 'bursar', schoolId, bursarResult.rows[0].email);

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `principal-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2026/2027', NOW(), NOW() + interval '365 days', true) RETURNING id`,
      [schoolId]
    );
    const termResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (school_id, session_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, 'First Term', NOW(), NOW() + interval '90 days', true) RETURNING id`,
      [schoolId, sessionResult.rows[0].id]
    );
    termId = termResult.rows[0].id;

    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'student', 'Ada', 'Obi', 'subject', FALSE) RETURNING id`,
      [schoolId, `student-${randomUUID()}@test.com`]
    );
    studentAdmissionNo = `SCH/2026/${randomUUID().slice(0, 6).toUpperCase()}`;
    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [schoolId, studentUserResult.rows[0].id, studentAdmissionNo]
    );

    const invoiceResult = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid') RETURNING id`,
      [schoolId, studentResult.rows[0].id, termId]
    );
    invoiceId = invoiceResult.rows[0].id;

    // A second student, same school, who has NOT had an invoice generated for
    // this term — exercises the feature's actual stated "no invoice" precondition
    // against a real, resolvable, active student (as opposed to an admission
    // number that matches no student at all, which is a different failure mode
    // tested separately below).
    const studentWithNoInvoiceUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'student', 'Bola', 'Musa', 'subject', FALSE) RETURNING id`,
      [schoolId, `student-no-invoice-${randomUUID()}@test.com`]
    );
    studentWithNoInvoiceAdmissionNo = `SCH/2026/${randomUUID().slice(0, 6).toUpperCase()}`;
    await pool.query(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3)`,
      [schoolId, studentWithNoInvoiceUserResult.rows[0].id, studentWithNoInvoiceAdmissionNo]
    );
    // Deliberately no fee_invoices row for this student/term.
  }, 30000);

  afterAll(async () => {
    // Scoped by school_id, so the second student added above (same school,
    // no invoice) is already covered by these same DELETEs — no separate
    // cleanup needed.
    await pool.query(`DELETE FROM payments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM fee_invoices WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
    // pool is NOT closed here — Task 4 adds a sibling describe block below
    // that still needs it. A single top-level afterAll closes it once.
  }, 30000);

  it('rejects a principal with 403 (this feature is bursar-gated, not principal-gated)', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 10000, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${principalToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews a valid row against an existing invoice', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 10000, 'cash', '2026-01-15', 'Receipt #1']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');

    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });
    expect(res.body.data.rows[0]).toMatchObject({ resolved_invoice_id: invoiceId, resolved_amount: 10000 });
  });

  it('flags an admission number that matches no active student', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['NO-SUCH-ADMISSION-NO', 10000, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('does not match an existing active student');
  });

  it('flags a row for a real, active student who has no invoice for the chosen term', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentWithNoInvoiceAdmissionNo, 10000, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('No invoice found');
  });

  it('flags an overpayment relative to the invoice balance', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 999999, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('exceeds the outstanding balance');
  });

  it('rejects a row with method=paystack outright', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 1000, 'paystack', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data.rows[0].status).toBe('error');
    expect(res.body.data.rows[0].errors[0]).toContain('Method must be one of');
  });

  it('rejects a missing term_id field', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 1000, 'cash', '', '']]);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(400);
  });

  it('rejects a workbook with more than 50 rows', async () => {
    const manyRows = Array.from({ length: 51 }, (_, i) => [`ADM-${i}`, 1000, 'cash', '', '']);
    const buffer = await xlsxBuffer(HEADERS, manyRows);
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_ROWS');
  });
});

describe('POST /:schoolId/payments-bulk-import/commit', () => {
  let schoolId: string;
  let bursarToken: string;
  let principalToken: string;
  let termId: string;
  let studentAdmissionNo: string;
  let invoiceId: string;

  beforeAll(async () => {
    const schoolResult = await pool.query<{ id: string }>(
      `INSERT INTO schools (name, slug, is_active) VALUES ($1, $2, true) RETURNING id`,
      ['Payment Bulk Commit Test School', `test-payment-commit-${randomUUID()}`]
    );
    schoolId = schoolResult.rows[0].id;

    const bursarResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'bursar', 'Test', 'Bursar', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `bursar-commit-${randomUUID()}@test.com`]
    );
    bursarToken = makeToken(bursarResult.rows[0].id, 'bursar', schoolId, bursarResult.rows[0].email);

    const principalResult = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'principal', 'Test', 'Principal', 'subject', FALSE) RETURNING id, email`,
      [schoolId, `principal-commit-${randomUUID()}@test.com`]
    );
    principalToken = makeToken(principalResult.rows[0].id, 'principal', schoolId, principalResult.rows[0].email);

    const sessionResult = await pool.query<{ id: string }>(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
       VALUES ($1, '2026/2027', NOW(), NOW() + interval '365 days', true) RETURNING id`,
      [schoolId]
    );
    const termResult = await pool.query<{ id: string }>(
      `INSERT INTO terms (school_id, session_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, 'First Term', NOW(), NOW() + interval '90 days', true) RETURNING id`,
      [schoolId, sessionResult.rows[0].id]
    );
    termId = termResult.rows[0].id;

    const studentUserResult = await pool.query<{ id: string }>(
      `INSERT INTO users (school_id, email, password_hash, role, first_name, last_name, teacher_mode, must_change_password)
       VALUES ($1, $2, 'test-hash', 'student', 'Chidi', 'Eze', 'subject', FALSE) RETURNING id`,
      [schoolId, `student-commit-${randomUUID()}@test.com`]
    );
    studentAdmissionNo = `SCH/2026/${randomUUID().slice(0, 6).toUpperCase()}`;
    const studentResult = await pool.query<{ id: string }>(
      `INSERT INTO students (school_id, user_id, admission_no) VALUES ($1, $2, $3) RETURNING id`,
      [schoolId, studentUserResult.rows[0].id, studentAdmissionNo]
    );

    const invoiceResult = await pool.query<{ id: string }>(
      `INSERT INTO fee_invoices (school_id, student_id, term_id, total_amount, amount_paid, balance, status)
       VALUES ($1, $2, $3, 50000, 0, 50000, 'unpaid') RETURNING id`,
      [schoolId, studentResult.rows[0].id, termId]
    );
    invoiceId = invoiceResult.rows[0].id;
  }, 30000);

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_logs WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM payments WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM fee_invoices WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM students WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM terms WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM academic_sessions WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM users WHERE school_id = $1`, [schoolId]);
    await pool.query(`DELETE FROM schools WHERE id = $1`, [schoolId]);
  }, 30000);

  async function preview(buffer: Buffer) {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/preview`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .field('term_id', termId)
      .attach('file', buffer, 'payments.xlsx');
    return res.body.data;
  }

  it('rejects a principal with 403', async () => {
    const res = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/commit`)
      .set('Authorization', `Bearer ${principalToken}`)
      .send({ term_id: termId, rows: [] });
    expect(res.status).toBe(403);
  });

  it('records a valid payment end-to-end, including a backdated payment_date', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 15000, 'cash', '2026-01-10', 'Receipt #99']]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/commit`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ term_id: termId, rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(0);
    expect(typeof commit.body.data.download_base64).toBe('string');

    const paymentRow = await pool.query(`SELECT amount, method, payment_date, reference FROM payments WHERE invoice_id = $1`, [invoiceId]);
    expect(paymentRow.rows).toHaveLength(1);
    expect(Number(paymentRow.rows[0].amount)).toBe(15000);
    expect(paymentRow.rows[0].reference).toBe('Receipt #99');
    expect(new Date(paymentRow.rows[0].payment_date).toISOString().slice(0, 10)).toBe('2026-01-10');

    const invoiceRow = await pool.query(`SELECT amount_paid, balance, status FROM fee_invoices WHERE id = $1`, [invoiceId]);
    expect(Number(invoiceRow.rows[0].amount_paid)).toBe(15000);
    expect(Number(invoiceRow.rows[0].balance)).toBe(35000);
    expect(invoiceRow.rows[0].status).toBe('partial');
  }, 30000);

  it('logs the per-payment audit entry against the payment id, not the invoice id', async () => {
    const buffer = await xlsxBuffer(HEADERS, [[studentAdmissionNo, 12000, 'cash', '', 'Receipt #100']]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 1, valid: 1, invalid: 0 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/commit`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ term_id: termId, rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);

    const paymentRow = await pool.query(`SELECT id FROM payments WHERE invoice_id = $1 AND reference = $2`, [invoiceId, 'Receipt #100']);
    expect(paymentRow.rows).toHaveLength(1);
    const paymentId = paymentRow.rows[0].id;

    const auditRow = await pool.query(
      `SELECT entity_id FROM audit_logs WHERE entity = 'payments' AND action_type = 'PAYMENT_RECORDED' AND entity_id = $1`,
      [paymentId]
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0].entity_id).toBe(paymentId);
    // The invoice id must NOT appear as the entity_id for this audit entry —
    // that was the bug: using row.resolved_invoice_id instead of the actual
    // payment's own id, which would make this payment unfindable by its id
    // in the audit log and collide with the invoice id-space instead.
    expect(paymentId).not.toBe(invoiceId);
  }, 30000);

  it('does not stop the batch when one row fails and a second, different-student row succeeds', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['NO-SUCH-ADMISSION', 5000, 'cash', '', ''],
      [studentAdmissionNo, 5000, 'bank_transfer', '', ''],
    ]);
    const data = await preview(buffer);
    expect(data.summary).toEqual({ total: 2, valid: 1, invalid: 1 });

    const commit = await request(app)
      .post(`/api/schools/${schoolId}/payments-bulk-import/commit`)
      .set('Authorization', `Bearer ${bursarToken}`)
      .send({ term_id: termId, rows: data.rows });

    expect(commit.status).toBe(200);
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.failed).toBe(1);
  }, 30000);
});

// Closes the shared pg pool once, after every describe block in this file has
// finished — closing it inside an individual describe's afterAll would break
// any sibling describe block that still needs to query the database.
afterAll(async () => {
  await pool.end();
});
