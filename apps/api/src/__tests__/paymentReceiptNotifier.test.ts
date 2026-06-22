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
    mockReceipt.generateReceipt.mockResolvedValueOnce('https://storage.example/receipts/pay-1.pdf');
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
      'Payment receipt — Chronix Edu',
      expect.stringContaining('https://storage.example/receipts/pay-1.pdf')
    );
    expect(mockEmail.sendEmail).toHaveBeenCalledWith(
      'parent2@example.com',
      'Payment receipt — Chronix Edu',
      expect.stringContaining('https://storage.example/receipts/pay-1.pdf')
    );
  });

  it('does nothing but log when the payment cannot be found', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(null);

    await notifyPaymentReceipt(SCHOOL_ID, PAYMENT_ID, STUDENT_ID);

    expect(mockReceipt.generateReceipt).not.toHaveBeenCalled();
    expect(mockEmail.sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when no parents are linked to the student', async () => {
    mockFees.getPaymentById.mockResolvedValueOnce(PAYMENT_ROW as never);
    mockReceipt.generateReceipt.mockResolvedValueOnce('https://storage.example/receipts/pay-1.pdf');
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
    mockReceipt.generateReceipt.mockResolvedValueOnce('https://storage.example/receipts/pay-1.pdf');
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
      'Payment receipt — Chronix Edu',
      expect.stringContaining('https://storage.example/receipts/pay-1.pdf')
    );
  });
});
