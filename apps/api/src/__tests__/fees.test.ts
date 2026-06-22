import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import feesRouter from '../routes/fees';
import { errorHandler } from '../middleware/errorHandler';
import * as feesQueries from '../db/queries/fees';
import * as auditLog from '../db/queries/auditLog';
import * as parentQueries from '../db/queries/parents';
import * as studentQueries from '../db/queries/students';
import * as paystackService from '../services/paystackService';
import * as receiptService from '../services/receiptService';
import * as paymentReceiptNotifier from '../services/paymentReceiptNotifier';
import * as rosterQueries from '../db/queries/roster';
import * as feeReminderService from '../services/feeReminderService';

jest.mock('../db/queries/fees');
jest.mock('../db/queries/auditLog');
jest.mock('../db/queries/parents');
jest.mock('../db/queries/students');
jest.mock('../db/queries/roster');
jest.mock('../services/paystackService');
jest.mock('../services/receiptService', () => ({ generateReceipt: jest.fn() }));
jest.mock('../services/paymentReceiptNotifier');
jest.mock('../services/feeReminderService');

const mockFees = feesQueries as jest.Mocked<typeof feesQueries>;
const mockAudit = auditLog as jest.Mocked<typeof auditLog>;
const mockParents = parentQueries as jest.Mocked<typeof parentQueries>;
const mockStudents = studentQueries as jest.Mocked<typeof studentQueries>;
const mockPaystack = paystackService as jest.Mocked<typeof paystackService>;
const mockReceipt = receiptService as jest.Mocked<typeof receiptService>;
const mockNotifier = paymentReceiptNotifier as jest.Mocked<typeof paymentReceiptNotifier>;
const mockRoster = rosterQueries as jest.Mocked<typeof rosterQueries>;
const mockFeeReminder = feeReminderService as jest.Mocked<typeof feeReminderService>;

process.env.JWT_SECRET = 'test-secret';

function makeToken(role: string, schoolId?: string, userId = 'user-uuid-001') {
  return jwt.sign(
    { user_id: userId, role, school_id: schoolId ?? null, email: 'test@test.com' },
    'test-secret',
    { expiresIn: '1h' }
  );
}

const app = express();
app.use(express.json());
app.use('/api/schools', feesRouter);
app.use(errorHandler);

const SCHOOL_ID = 'school-uuid-001';
const TERM_ID = '11111111-1111-4111-8111-111111111111';
const CLASS_ID = '22222222-2222-4222-8222-222222222222';
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';
const PAYMENT_ID = '55555555-5555-4555-8555-555555555555';
const PAYMENT_AMOUNT = 10000;
const INVOICE_TOTAL_AMOUNT = 15000;

beforeEach(() => jest.clearAllMocks());

// ── POST /:schoolId/fee-structures ──────────────────────────────────────────────

describe('POST /api/schools/:schoolId/fee-structures', () => {
  const FEE_STRUCTURE_ROW = {
    id: 'fs-1', school_id: SCHOOL_ID, class_id: CLASS_ID, term_id: TERM_ID,
    component_name: 'Tuition', amount: 50000, is_mandatory: true, created_at: '2026-01-01',
  };

  it('creates a fee structure for bursar and logs audit', async () => {
    mockFees.insertFeeStructure.mockResolvedValueOnce(FEE_STRUCTURE_ROW as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-structures`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID, class_id: CLASS_ID, component_name: 'Tuition', amount: 50000, is_mandatory: true });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(FEE_STRUCTURE_ROW);
    expect(mockFees.insertFeeStructure).toHaveBeenCalledWith(SCHOOL_ID, {
      term_id: TERM_ID, class_id: CLASS_ID, component_name: 'Tuition', amount: 50000, is_mandatory: true,
    });
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'FEE_STRUCTURE_CREATED', entity: 'fee_structures', entityId: 'fs-1',
    }));
  });

  it('defaults is_mandatory to true and allows a null class_id', async () => {
    mockFees.insertFeeStructure.mockResolvedValueOnce({ ...FEE_STRUCTURE_ROW, class_id: null } as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-structures`)
      .set('Authorization', `Bearer ${makeToken('super_admin', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID, class_id: null, component_name: 'Sports Levy', amount: 1500 });

    expect(res.status).toBe(201);
    expect(mockFees.insertFeeStructure).toHaveBeenCalledWith(SCHOOL_ID, {
      term_id: TERM_ID, class_id: null, component_name: 'Sports Levy', amount: 1500, is_mandatory: true,
    });
  });

  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-structures`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFees.insertFeeStructure).not.toHaveBeenCalled();
  });

  it('returns 403 for principal', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-structures`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID, class_id: null, component_name: 'Tuition', amount: 50000 });

    expect(res.status).toBe(403);
  });
});

// ── GET /:schoolId/fee-structures ───────────────────────────────────────────────

describe('GET /api/schools/:schoolId/fee-structures', () => {
  it('lists fee structures for a term', async () => {
    mockFees.listFeeStructures.mockResolvedValueOnce([]);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-structures?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(mockFees.listFeeStructures).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, undefined);
  });

  it('passes class_id through when provided', async () => {
    mockFees.listFeeStructures.mockResolvedValueOnce([]);

    await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-structures?term_id=${TERM_ID}&class_id=${CLASS_ID}`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(mockFees.listFeeStructures).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, CLASS_ID);
  });

  it('returns 400 when term_id is missing', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-structures`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── GET /:schoolId/fee-invoices ─────────────────────────────────────────────────

describe('GET /api/schools/:schoolId/fee-invoices', () => {
  it('lists invoices for a term', async () => {
    mockFees.listInvoices.mockResolvedValueOnce([]);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(mockFees.listInvoices).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, { classId: undefined, status: undefined });
  });

  it('passes class_id and status filters through', async () => {
    mockFees.listInvoices.mockResolvedValueOnce([]);

    await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices?term_id=${TERM_ID}&class_id=${CLASS_ID}&status=unpaid`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(mockFees.listInvoices).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, { classId: CLASS_ID, status: 'unpaid' });
  });

  it('returns 400 when term_id is missing', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices?term_id=${TERM_ID}&status=bogus`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 for parent', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
    expect(mockFees.listInvoices).not.toHaveBeenCalled();
  });
});

// ── POST /:schoolId/fee-invoices/generate ───────────────────────────────────────

describe('POST /api/schools/:schoolId/fee-invoices/generate', () => {
  it('generates invoices for bursar', async () => {
    mockFees.generateInvoices.mockResolvedValueOnce([{ id: 'inv-1' }] as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-invoices/generate`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID, class_id: CLASS_ID });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'inv-1' }]);
    expect(mockFees.generateInvoices).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, CLASS_ID);
  });

  it('returns 404 when the term does not belong to the school', async () => {
    mockFees.generateInvoices.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-invoices/generate`)
      .set('Authorization', `Bearer ${makeToken('super_admin', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID, class_id: CLASS_ID });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 403 for principal', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-invoices/generate`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID, class_id: CLASS_ID });

    expect(res.status).toBe(403);
    expect(mockFees.generateInvoices).not.toHaveBeenCalled();
  });

  it('returns 400 when class_id is missing', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-invoices/generate`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ term_id: TERM_ID });

    expect(res.status).toBe(400);
  });
});

// ── GET /:schoolId/fee-invoices/student/:studentId ──────────────────────────────

describe('GET /api/schools/:schoolId/fee-invoices/student/:studentId', () => {
  const INVOICE = {
    id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
    total_amount: 15000, amount_paid: 5000, balance: 10000, status: 'partial',
    created_at: '', updated_at: '', payments: [],
  };

  it('returns the invoice for staff', async () => {
    mockFees.getInvoiceByStudent.mockResolvedValueOnce(INVOICE as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/student/${STUDENT_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(INVOICE);
    expect(mockFees.getInvoiceByStudent).toHaveBeenCalledWith(SCHOOL_ID, STUDENT_ID, TERM_ID);
  });

  it('returns 404 when no invoice exists', async () => {
    mockFees.getInvoiceByStudent.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/student/${STUDENT_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('allows a linked parent', async () => {
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);
    mockFees.getInvoiceByStudent.mockResolvedValueOnce(INVOICE as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/student/${STUDENT_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID, 'parent-user-1')}`);

    expect(res.status).toBe(200);
    expect(mockParents.isParentLinkedToStudent).toHaveBeenCalledWith('parent-user-1', STUDENT_ID);
  });

  it('forbids a parent not linked to the student', async () => {
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(false);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/student/${STUDENT_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID, 'parent-user-1')}`);

    expect(res.status).toBe(403);
    expect(mockFees.getInvoiceByStudent).not.toHaveBeenCalled();
  });

  it('allows a student viewing their own invoice', async () => {
    mockStudents.findStudentByUserId.mockResolvedValueOnce({ id: STUDENT_ID } as never);
    mockFees.getInvoiceByStudent.mockResolvedValueOnce(INVOICE as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/student/${STUDENT_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('student', SCHOOL_ID, 'student-user-1')}`);

    expect(res.status).toBe(200);
  });

  it("forbids a student viewing another student's invoice", async () => {
    mockStudents.findStudentByUserId.mockResolvedValueOnce({ id: 'some-other-student' } as never);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/student/${STUDENT_ID}?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('student', SCHOOL_ID, 'student-user-1')}`);

    expect(res.status).toBe(403);
    expect(mockFees.getInvoiceByStudent).not.toHaveBeenCalled();
  });

  it('returns 400 when term_id is missing', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/student/${STUDENT_ID}`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(400);
  });
});

// ── GET /:schoolId/fee-invoices/outstanding ─────────────────────────────────────

describe('GET /api/schools/:schoolId/fee-invoices/outstanding', () => {
  it('returns outstanding balances for principal', async () => {
    mockFees.getOutstandingBalances.mockResolvedValueOnce([]);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/outstanding?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(mockFees.getOutstandingBalances).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, undefined);
  });

  it('passes class_id through when provided', async () => {
    mockFees.getOutstandingBalances.mockResolvedValueOnce([]);

    await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/outstanding?term_id=${TERM_ID}&class_id=${CLASS_ID}`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(mockFees.getOutstandingBalances).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, CLASS_ID);
  });

  it('returns 403 for parent', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/outstanding?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
  });
});

// ── GET /:schoolId/fee-invoices/summary ─────────────────────────────────────────

describe('GET /api/schools/:schoolId/fee-invoices/summary', () => {
  it('returns the collection summary', async () => {
    const summary = {
      total_expected: 45000, total_collected: 15000, total_outstanding: 30000,
      counts: { unpaid: 1, partial: 1, paid: 1 },
    };
    mockFees.getCollectionSummary.mockResolvedValueOnce(summary);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/summary?term_id=${TERM_ID}&class_id=${CLASS_ID}`)
      .set('Authorization', `Bearer ${makeToken('super_admin', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(summary);
    expect(mockFees.getCollectionSummary).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID, CLASS_ID);
  });

  it('returns 403 for student', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/fee-invoices/summary?term_id=${TERM_ID}`)
      .set('Authorization', `Bearer ${makeToken('student', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
  });
});

// ── POST /:schoolId/payments ─────────────────────────────────────────────────────

describe('POST /api/schools/:schoolId/payments', () => {
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'cash', reference: 'RCT-1', paystack_reference: null,
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };

  it('records a cash payment and logs audit', async () => {
    mockFees.recordPayment.mockResolvedValueOnce(PAYMENT_RESULT as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: PAYMENT_AMOUNT, method: 'cash', reference: 'RCT-1' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(PAYMENT_RESULT);
    expect(mockFees.recordPayment).toHaveBeenCalledWith(SCHOOL_ID, INVOICE_ID, {
      amount: PAYMENT_AMOUNT, method: 'cash', reference: 'RCT-1', paystack_reference: null, recorded_by: 'user-uuid-001',
    });
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });

  it('returns 404 when the invoice does not exist', async () => {
    mockFees.recordPayment.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'cash' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 when paystack_reference is missing for paystack payments', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'paystack' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns 503 when paystack is not configured', async () => {
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(false);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'paystack', paystack_reference: 'ref-123' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYSTACK_NOT_CONFIGURED');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns 502 when paystack verification fails', async () => {
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'paystack', paystack_reference: 'ref-123' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYSTACK_VERIFY_FAILED');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns 400 when the paystack transaction was not successful', async () => {
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'failed', amount: 10000, currency: 'NGN' });

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'paystack', paystack_reference: 'ref-123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_NOT_VERIFIED');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('records a verified paystack payment', async () => {
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amount: 10000, currency: 'NGN' });
    mockFees.recordPayment.mockResolvedValueOnce(PAYMENT_RESULT as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'paystack', paystack_reference: 'ref-123' });

    expect(res.status).toBe(201);
    expect(mockFees.recordPayment).toHaveBeenCalledWith(SCHOOL_ID, INVOICE_ID, {
      amount: 10000, method: 'paystack', reference: null, paystack_reference: 'ref-123', recorded_by: 'user-uuid-001',
    });
  });

  it('returns 409 when the paystack reference has already been recorded', async () => {
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ status: 'success', amount: 10000, currency: 'NGN' });
    const dbError = new Error('duplicate key value violates unique constraint "payments_paystack_reference_key"') as Error & { code: string };
    dbError.code = '23505';
    mockFees.recordPayment.mockRejectedValueOnce(dbError);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'paystack', paystack_reference: 'ref-123' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_PAYSTACK_REFERENCE');
  });

  it('returns 403 for principal', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 10000, method: 'cash' });

    expect(res.status).toBe(403);
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-positive amount', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 0, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ── POST /:schoolId/payments/paystack/initiate ──────────────────────────────────

describe('POST /api/schools/:schoolId/payments/paystack/initiate', () => {
  const INVOICE_ROW = {
    id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
    total_amount: 15000, amount_paid: 5000, balance: 10000, status: 'partial',
    created_at: '', updated_at: null,
  };

  const PAYSTACK_INIT_RESULT = {
    authorization_url: 'https://checkout.paystack.com/abc123',
    access_code: 'abc123',
    reference: 'ref-generated-123',
  };

  it('initializes a transaction for the outstanding balance and returns the authorization url', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(INVOICE_ROW as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.initializePaystackTransaction.mockResolvedValueOnce(PAYSTACK_INIT_RESULT);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(PAYSTACK_INIT_RESULT);
    expect(mockPaystack.initializePaystackTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@test.com',
        amountKobo: 1000000,
        callbackUrl: expect.stringContaining(`/api/schools/${SCHOOL_ID}/payments/paystack/callback`),
        metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
      })
    );
  });

  it('allows specifying a partial amount not exceeding the balance', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(INVOICE_ROW as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.initializePaystackTransaction.mockResolvedValueOnce(PAYSTACK_INIT_RESULT);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 5000 });

    expect(res.status).toBe(200);
    expect(mockPaystack.initializePaystackTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amountKobo: 500000 })
    );
  });

  it('allows a student to initiate payment for their own invoice', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(INVOICE_ROW as never);
    mockStudents.findStudentByUserId.mockResolvedValueOnce({ id: STUDENT_ID } as never);
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.initializePaystackTransaction.mockResolvedValueOnce(PAYSTACK_INIT_RESULT);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('student', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(200);
  });

  it('returns 400 VALIDATION_ERROR when invoice_id is missing', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when the invoice does not exist', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 403 when the parent is not linked to the invoice student', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(INVOICE_ROW as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(false);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(403);
    expect(mockPaystack.initializePaystackTransaction).not.toHaveBeenCalled();
  });

  it('returns 403 for bursar (staff cannot initiate parent payments)', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(403);
    expect(mockFees.getInvoiceById).not.toHaveBeenCalled();
  });

  it('returns 400 INVOICE_ALREADY_SETTLED when the balance is zero', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce({ ...INVOICE_ROW, balance: 0, status: 'paid' } as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVOICE_ALREADY_SETTLED');
  });

  it('returns 400 AMOUNT_EXCEEDS_BALANCE when amount is greater than the balance', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(INVOICE_ROW as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID, amount: 20000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect(mockPaystack.initializePaystackTransaction).not.toHaveBeenCalled();
  });

  it('returns 503 when paystack is not configured', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(INVOICE_ROW as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(false);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYSTACK_NOT_CONFIGURED');
  });

  it('returns 502 when paystack initialization fails', async () => {
    mockFees.getInvoiceById.mockResolvedValueOnce(INVOICE_ROW as never);
    mockParents.isParentLinkedToStudent.mockResolvedValueOnce(true);
    mockPaystack.isPaystackConfigured.mockReturnValueOnce(true);
    mockPaystack.initializePaystackTransaction.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/initiate`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`)
      .send({ invoice_id: INVOICE_ID });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYSTACK_INIT_FAILED');
  });
});

// ── GET /:schoolId/payments/paystack/callback ───────────────────────────────────

describe('GET /api/schools/:schoolId/payments/paystack/callback', () => {
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'paystack', reference: null, paystack_reference: 'ref-xyz',
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };

  const SUCCESS_VERIFICATION = {
    status: 'success',
    amount: PAYMENT_AMOUNT,
    currency: 'NGN',
    reference: 'ref-xyz',
    metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
  };

  it('verifies the transaction, records the payment, and redirects with payment=success', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(SUCCESS_VERIFICATION);
    mockFees.recordPayment.mockResolvedValueOnce(PAYMENT_RESULT as never);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=success');
    expect(mockFees.recordPayment).toHaveBeenCalledWith(SCHOOL_ID, INVOICE_ID, {
      amount: PAYMENT_AMOUNT, method: 'paystack', reference: null, paystack_reference: 'ref-xyz', recorded_by: 'user-uuid-001',
    });
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });

  it('redirects with payment=error when reference is missing', async () => {
    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=error when verification fails', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=failed when the transaction was not successful', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({ ...SUCCESS_VERIFICATION, status: 'failed' });

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=failed');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=error when metadata does not match the school in the URL', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce({
      ...SUCCESS_VERIFICATION,
      metadata: { ...SUCCESS_VERIFICATION.metadata, school_id: 'other-school' },
    });

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('redirects with payment=success when the paystack reference was already recorded (idempotent)', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(SUCCESS_VERIFICATION);
    const dbError = new Error('duplicate key value violates unique constraint "payments_paystack_reference_key"') as Error & { code: string };
    dbError.code = '23505';
    mockFees.recordPayment.mockRejectedValueOnce(dbError);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=success');
  });

  it('redirects with payment=error when the invoice no longer exists', async () => {
    mockPaystack.verifyPaystackTransaction.mockResolvedValueOnce(SUCCESS_VERIFICATION);
    mockFees.recordPayment.mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/schools/${SCHOOL_ID}/payments/paystack/callback?reference=ref-xyz`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('payment=error');
  });
});

// ── POST /:schoolId/payments/paystack/webhook ───────────────────────────────────

describe('POST /api/schools/:schoolId/payments/paystack/webhook', () => {
  const PAYMENT_RESULT = {
    payment: {
      id: 'pay-1', invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
      payment_date: '', method: 'paystack', reference: null, paystack_reference: 'ref-xyz',
      recorded_by: 'user-uuid-001', created_at: '',
    },
    invoice: {
      id: INVOICE_ID, school_id: SCHOOL_ID, student_id: STUDENT_ID, term_id: TERM_ID,
      total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, status: 'paid',
      created_at: '', updated_at: '',
    },
  };

  const CHARGE_SUCCESS_EVENT = {
    event: 'charge.success',
    data: {
      reference: 'ref-xyz',
      amount: PAYMENT_AMOUNT * 100,
      metadata: { school_id: SCHOOL_ID, invoice_id: INVOICE_ID, recorded_by: 'user-uuid-001' },
    },
  };

  it('returns 401 when the signature is invalid', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(false);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'bad-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns 401 when the signature header is missing', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('ignores events that are not charge.success', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send({ event: 'transfer.success', data: {} });

    expect(res.status).toBe(200);
    expect(res.body.data.ignored).toBe(true);
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('records the payment on charge.success and logs audit', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockFees.recordPayment.mockResolvedValueOnce(PAYMENT_RESULT as never);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(true);
    expect(mockFees.recordPayment).toHaveBeenCalledWith(SCHOOL_ID, INVOICE_ID, {
      amount: PAYMENT_AMOUNT, method: 'paystack', reference: null, paystack_reference: 'ref-xyz', recorded_by: 'user-uuid-001',
    });
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      schoolId: SCHOOL_ID, actionType: 'PAYMENT_RECORDED', entity: 'payments', entityId: 'pay-1',
    }));
    expect(mockNotifier.notifyPaymentReceipt).toHaveBeenCalledWith(SCHOOL_ID, 'pay-1', STUDENT_ID);
  });

  it('ignores events whose metadata school_id does not match the URL', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send({
        event: 'charge.success',
        data: { ...CHARGE_SUCCESS_EVENT.data, metadata: { ...CHARGE_SUCCESS_EVENT.data.metadata, school_id: 'other-school' } },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.ignored).toBe(true);
    expect(mockFees.recordPayment).not.toHaveBeenCalled();
  });

  it('returns processed:false (duplicate) for an already-recorded paystack reference', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    const dbError = new Error('duplicate key value violates unique constraint "payments_paystack_reference_key"') as Error & { code: string };
    dbError.code = '23505';
    mockFees.recordPayment.mockRejectedValueOnce(dbError);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(false);
    expect(res.body.data.duplicate).toBe(true);
    expect(mockNotifier.notifyPaymentReceipt).not.toHaveBeenCalled();
  });

  it('returns processed:false when the invoice no longer exists', async () => {
    mockPaystack.verifyPaystackWebhookSignature.mockReturnValueOnce(true);
    mockFees.recordPayment.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/payments/paystack/webhook`)
      .set('X-Paystack-Signature', 'good-signature')
      .send(CHARGE_SUCCESS_EVENT);

    expect(res.status).toBe(200);
    expect(res.body.data.processed).toBe(false);
  });
});

// ── GET /:schoolId/payments/:paymentId/receipt ──────────────────────────────────

describe('GET /api/schools/:schoolId/payments/:paymentId/receipt', () => {
  const PAYMENT_RECEIPT_ROW = {
    id: PAYMENT_ID, invoice_id: INVOICE_ID, school_id: SCHOOL_ID, amount: 10000,
    payment_date: '2026-06-11', method: 'cash', reference: 'RCT-1', paystack_reference: null,
    recorded_by: 'user-uuid-001', created_at: '',
    total_amount: 15000, amount_paid: 15000, balance: 0, invoice_status: 'paid',
    first_name: 'Amina', last_name: 'Okonkwo', admission_no: 'CE/2026/001',
    class_name: 'JSS 1A', term_name: 'First Term', session_name: '2025/2026',
  };

  it('generates and returns a receipt PDF url for bursar', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_RECEIPT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('https://storage.example/receipts/pay-1.pdf');

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/payments/${PAYMENT_ID}/receipt`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ url: 'https://storage.example/receipts/pay-1.pdf' });
    expect(mockFees.getPaymentById).toHaveBeenCalledWith(SCHOOL_ID, PAYMENT_ID);
    expect(mockReceipt.generateReceipt).toHaveBeenCalledWith(SCHOOL_ID, PAYMENT_RECEIPT_ROW);
  });

  it('returns 404 when the payment does not exist for the school', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/payments/${PAYMENT_ID}/receipt`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockReceipt.generateReceipt).not.toHaveBeenCalled();
  });

  it('returns 403 for parent', async () => {
    const res = await request(app)
      .get(`/api/schools/${SCHOOL_ID}/payments/${PAYMENT_ID}/receipt`)
      .set('Authorization', `Bearer ${makeToken('parent', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
    expect(mockFees.getPaymentById).not.toHaveBeenCalled();
  });
});

// ── POST /:schoolId/fee-reminders/run ───────────────────────────────────────────

describe('POST /api/schools/:schoolId/fee-reminders/run', () => {
  it('runs reminders for the current term and returns the count for bursar', async () => {
    mockRoster.getActiveTerm.mockResolvedValueOnce({ id: TERM_ID, name: 'Term 1', session_id: 'session-1' });
    mockFeeReminder.sendFeeRemindersForSchool.mockResolvedValueOnce(3);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-reminders/run`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.reminders_sent).toBe(3);
    expect(mockFeeReminder.sendFeeRemindersForSchool).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID);
  });

  it('returns 404 when the school has no active term', async () => {
    mockRoster.getActiveTerm.mockResolvedValueOnce(null);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-reminders/run`)
      .set('Authorization', `Bearer ${makeToken('bursar', SCHOOL_ID)}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(mockFeeReminder.sendFeeRemindersForSchool).not.toHaveBeenCalled();
  });

  it('returns 403 for principal', async () => {
    const res = await request(app)
      .post(`/api/schools/${SCHOOL_ID}/fee-reminders/run`)
      .set('Authorization', `Bearer ${makeToken('principal', SCHOOL_ID)}`);

    expect(res.status).toBe(403);
    expect(mockFeeReminder.sendFeeRemindersForSchool).not.toHaveBeenCalled();
  });
});
