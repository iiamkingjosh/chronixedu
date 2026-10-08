/**
 * Who does the school's fee work (Batch 9, task 8; Moses, 8 Oct 2026).
 *
 * - The principal has everything the bursar has: fee lines, invoices, payments, refunds and reminders. A school
 *   with no bursar is never stuck (spec decision 4, and the 8 Oct answer to question 1). Fee lines, invoices,
 *   payments, refunds and reminders were the bursar's alone.
 * - A student reads no fee invoice and starts no payment: students have no fees page, and parents pay. Both were
 *   allowed. A parent still reads and pays their own child's.
 */
import request from 'supertest';
import { buildApp, seed, token, tokens, IDS as I, pool } from './helpers';

// Recording a payment starts the parent's receipt PDF without waiting; stubbed (as convenienceFee.db.test.ts does).
jest.mock('../services/paymentReceiptNotifier', () => ({ notifyPaymentReceipt: jest.fn() }));

const app = buildApp();
const base = `/api/schools/${I.schoolA}`;
const BURSAR = '30000000-0000-4000-8000-0000000000a1';
const principal = () => tokens.principalA();

beforeEach(async () => {
  await seed();
  await pool.query(`UPDATE schools SET subscription_tier = 'trial' WHERE id = $1`, [I.schoolA]);
  await pool.query(
    `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, is_active, teacher_mode, must_change_password)
     VALUES ($1, $2, 'bursar@fees.test', 'x', 'bursar', 'Bur', 'Sar', true, 'subject', false)`, [BURSAR, I.schoolA]);
});
afterAll(() => pool.end());

const invoiceOf = async (studentId: string) =>
  (await pool.query<{ id: string }>(`SELECT id FROM fee_invoices WHERE student_id = $1 AND term_id = $2`, [studentId, I.termA])).rows[0]?.id;

it('the principal sets fee lines, raises invoices, records a payment and a refund, and sends reminders', async () => {
  const line = await request(app).post(`${base}/fee-structures`).set('Authorization', principal())
    .send({ term_id: I.termA, class_id: I.jss2a, component_name: 'Tuition', amount: '15000' });
  expect(line.status).toBe(201);

  const generated = await request(app).post(`${base}/fee-invoices/generate`).set('Authorization', principal())
    .send({ term_id: I.termA, class_id: I.jss2a });
  expect([200, 201]).toContain(generated.status);
  const invoiceId = await invoiceOf(I.s1);
  expect(invoiceId).toBeDefined();

  const paid = await request(app).post(`${base}/payments`).set('Authorization', principal())
    .send({ invoice_id: invoiceId, amount: '5000', method: 'cash' });
  expect(paid.status).toBe(201);
  const paymentId = (await pool.query<{ id: string }>(`SELECT id FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].id;

  const refunded = await request(app).post(`${base}/payments/${paymentId}/refunds`).set('Authorization', principal())
    .send({ amount: '1000', method: 'cash', reason: 'overpaid' });
  expect(refunded.status).toBe(201);

  expect((await request(app).post(`${base}/fee-reminders/run`).set('Authorization', principal())).status).toBe(200);
});

it('the bursar still does all of it, and a teacher none of it', async () => {
  const add = (auth: string) => request(app).post(`${base}/fee-structures`).set('Authorization', auth)
    .send({ term_id: I.termA, class_id: I.jss2a, component_name: 'Books', amount: '2000' });
  expect((await add(token(BURSAR, 'bursar', I.schoolA))).status).toBe(201);
  expect((await add(tokens.math())).status).toBe(403);
});

it('a student reads no invoice and starts no payment; a parent reads their own child\'s', async () => {
  await request(app).post(`${base}/fee-structures`).set('Authorization', principal())
    .send({ term_id: I.termA, class_id: I.jss2a, component_name: 'Tuition', amount: '15000' });
  await request(app).post(`${base}/fee-invoices/generate`).set('Authorization', principal()).send({ term_id: I.termA, class_id: I.jss2a });
  const invoiceId = await invoiceOf(I.s1);

  const invoiceRead = (auth: string) => request(app).get(`${base}/fee-invoices/student/${I.s1}`).set('Authorization', auth).query({ term_id: I.termA });
  expect((await invoiceRead(tokens.parentA())).status).toBe(200);
  const read = await invoiceRead(tokens.studentS1());
  expect(read.status).toBe(403);
  const start = await request(app).post(`${base}/payments/paystack/initiate`).set('Authorization', tokens.studentS1())
    .send({ invoice_id: invoiceId });
  expect(start.status).toBe(403);
  expect(start.body.error.code).toBe('FORBIDDEN');
});
