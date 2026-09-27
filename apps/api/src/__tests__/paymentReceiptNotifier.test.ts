import { notifyPaymentReceipt } from '../services/paymentReceiptNotifier';
import * as feesQueries from '../db/queries/fees';
import * as parentQueries from '../db/queries/parents';
import * as receiptService from '../services/receiptService';
import * as emailService from '../services/emailService';

jest.mock('../db/queries/fees');
jest.mock('../db/queries/parents');
jest.mock('../services/receiptService', () => ({ generateReceipt: jest.fn() }));
jest.mock('../services/emailService');
jest.mock('../config/logger', () => ({ logger: { error: jest.fn() } }));

const mockFees = feesQueries as jest.Mocked<typeof feesQueries>;
const mockParents = parentQueries as jest.Mocked<typeof parentQueries>;
const mockReceipt = receiptService as jest.Mocked<typeof receiptService>;
const mockEmail = emailService as jest.Mocked<typeof emailService>;

const SCHOOL_ID = 'school-1';
const PAYMENT_ID = 'pay-1';
const STUDENT_ID = 'student-1';
const PAYMENT_AMOUNT = 10000;
const INVOICE_TOTAL_AMOUNT = 15000;

const PAYMENT_ROW = {
  id: PAYMENT_ID, invoice_id: 'inv-1', school_id: SCHOOL_ID, amount: PAYMENT_AMOUNT,
  payment_date: '2026-06-22', method: 'cash', reference: 'RCT-1', paystack_reference: null,
  recorded_by: 'user-1', created_at: '', student_id: STUDENT_ID,
  total_amount: INVOICE_TOTAL_AMOUNT, amount_paid: INVOICE_TOTAL_AMOUNT, balance: 0, invoice_status: 'paid',
  first_name: 'Amina', last_name: 'Okonkwo', admission_no: 'CE/2026/001',
  class_name: 'JSS 1A', term_name: 'First Term', session_name: '2025/2026',
};

beforeEach(() => jest.clearAllMocks());

describe('notifyPaymentReceipt', () => {
  it('generates the receipt and emails every linked parent a link', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('receipts/school-1/pay-1.pdf');
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: 'p1', email: 'parent1@example.com', phone: null },
      { parent_id: 'p2', email: 'parent2@example.com', phone: null },
    ] as never);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    expect(mockFees.getPaymentById).toHaveBeenCalledWith(SCHOOL_ID, PAYMENT_ID);
    expect(mockReceipt.generateReceipt).toHaveBeenCalledWith(SCHOOL_ID, PAYMENT_ROW);
    expect(mockParents.getParentsForStudent).toHaveBeenCalledWith(STUDENT_ID);
    expect(mockEmail.sendEmail).toHaveBeenCalledTimes(2);
    expect(mockEmail.sendEmail).toHaveBeenCalledWith(
      'parent1@example.com',
      'Payment receipt — fees settled — Chronix Edu',
      expect.stringContaining('/parent/fees')
    );
    expect(mockEmail.sendEmail).toHaveBeenCalledWith(
      'parent2@example.com',
      'Payment receipt — fees settled — Chronix Edu',
      expect.stringContaining('/parent/fees')
    );
  });

  it('never embeds the raw storage path/URL in the email — only the authenticated in-app link', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('receipts/school-1/pay-1.pdf');
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: 'p1', email: 'parent1@example.com', phone: null },
    ] as never);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    const body = mockEmail.sendEmail.mock.calls[0][2] as string;
    expect(body).not.toContain('receipts/school-1/pay-1.pdf');
  });

  it('does nothing but log when the payment cannot be found', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(null);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    expect(mockReceipt.generateReceipt).not.toHaveBeenCalled();
    expect(mockEmail.sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when no parents are linked to the student', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('receipts/school-1/pay-1.pdf');
    mockParents.getParentsForStudent.mockResolvedValueOnce([]);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    expect(mockEmail.sendEmail).not.toHaveBeenCalled();
  });

  it('never throws when receipt generation fails', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockRejectedValueOnce(new Error('Puppeteer crashed'));

    await expect(notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID)).resolves.toBeUndefined();
    expect(mockEmail.sendEmail).not.toHaveBeenCalled();
  });

  it('never throws when getPaymentById itself throws', async () => {
    mockFees.getPaymentById.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID)).resolves.toBeUndefined();
  });

  it('still emails the second parent when the first parent email fails', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('receipts/school-1/pay-1.pdf');
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: 'p1', email: 'parent1@example.com', phone: null },
      { parent_id: 'p2', email: 'parent2@example.com', phone: null },
    ] as never);
    mockEmail.sendEmail.mockRejectedValueOnce(new Error('SMTP rejected'));
    mockEmail.sendEmail.mockResolvedValueOnce(undefined as never);

    await expect(notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID)).resolves.toBeUndefined();

    expect(mockEmail.sendEmail).toHaveBeenCalledTimes(2);
    expect(mockEmail.sendEmail).toHaveBeenCalledWith(
      'parent2@example.com',
      'Payment receipt — fees settled — Chronix Edu',
      expect.stringContaining('/parent/fees')
    );
  });
});

describe('the receipt states what is still owed', () => {
  // Partial payment is about to be offered to parents. While an online payment was
  // always the whole balance, "we have received a payment of X" could only mean settled;
  // once a parent can pay a third of a term's fees, the same sentence reads as paid in
  // full. Nothing in the partial-payment change points at this file, which is why it is
  // covered here rather than left to be noticed later.
  const PARTIAL = {
    ...PAYMENT_ROW,
    amount: 50000, total_amount: 150000, amount_paid: 50000,
    balance: 100000, invoice_status: 'partial',
  };

  async function emailFor(row: Record<string, unknown>) {
    mockFees.getPaymentById.mockResolvedValueOnce(row as never);
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: 'p1', email: 'parent1@example.com', first_name: 'A', last_name: 'B' },
    ] as never);
    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);
    const call = (mockEmail.sendEmail as jest.Mock).mock.calls[0];
    return { subject: call[1] as string, body: call[2] as string };
  }

  it('names the outstanding balance and the total in the body', async () => {
    const { body } = await emailFor(PARTIAL);
    expect(body).toContain('Outstanding balance');
    expect(body).toContain('100,000.00');
    expect(body).toContain('150,000.00');
  });

  it('puts the outstanding amount in the subject, visible without opening the email', async () => {
    const { subject } = await emailFor(PARTIAL);
    expect(subject).toContain('100,000.00');
    expect(subject).toContain('outstanding');
  });

  it('does not tell a partially-paying parent the fees are settled', async () => {
    const { body } = await emailFor(PARTIAL);
    expect(body).not.toContain('in full');
    expect(body).not.toContain('no outstanding balance');
  });

  it('says settled, and mentions no balance, when the invoice is settled', async () => {
    const { subject, body } = await emailFor(PAYMENT_ROW);
    expect(subject).toContain('fees settled');
    expect(body).toContain('no outstanding balance');
    expect(body).not.toContain('Outstanding balance');
  });

  it('treats an overpayment credit as settled rather than reporting a negative balance', async () => {
    // Paystack overpayments are recorded in full and the balance goes negative by
    // design. A parent must never be told they owe minus five hundred naira.
    const { subject, body } = await emailFor({ ...PAYMENT_ROW, balance: -500 });
    expect(subject).toContain('fees settled');
    expect(body).not.toContain('-500');
  });
});
