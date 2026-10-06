import puppeteer from 'puppeteer';
import { generateReceipt } from '../services/receiptService';
import { findSchoolById } from '../db/queries/schools';
import type { PaymentReceiptRow } from '../db/queries/fees';

/**
 * What a receipt says beside the payment (6 Oct 2026): a refund against it (migration 063), and a
 * convenience fee the parent paid on top (migration 062's record), each only when there is one. The
 * renderer is stood in for; the template and the data it is given are real.
 */
jest.mock('../db/queries/schools');
jest.mock('../supabaseClient', () => {
  const storageApi = { upload: jest.fn().mockResolvedValue({ error: null }), download: jest.fn() };
  return { supabaseAdmin: { storage: { from: jest.fn(() => storageApi) } }, supabase: {} };
});
jest.mock('puppeteer', () => {
  const page = {
    setRequestInterception: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    setContent: jest.fn().mockResolvedValue(undefined),
    pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const browser = { isConnected: () => true, newPage: jest.fn().mockResolvedValue(page), close: jest.fn() };
  return { launch: jest.fn().mockResolvedValue(browser), __mockPage: page };
});

const setContent = (puppeteer as unknown as { __mockPage: { setContent: jest.Mock } }).__mockPage.setContent;

const payment = (overrides: Partial<PaymentReceiptRow>): PaymentReceiptRow => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000001', invoice_id: 'inv-1', school_id: 'school-1', amount: 30000,
  payment_date: '2026-10-06', method: 'paystack', reference: null, paystack_reference: 'ref-1',
  recorded_by: 'parent-1', created_at: '', refunded_kobo: '0', convenience_fee_kobo: '0',
  student_id: 'student-1', total_amount: 100000, amount_paid: 30000, balance: 70000, invoice_status: 'partial',
  first_name: 'Amina', last_name: 'Okonkwo', admission_no: 'CE/2026/001', class_name: 'JSS 1A',
  term_name: 'First Term', session_name: '2026/2027',
  ...overrides,
} as PaymentReceiptRow);

async function rendered(row: PaymentReceiptRow): Promise<string> {
  setContent.mockClear();
  await generateReceipt('school-1', row);
  return setContent.mock.calls[0][0] as string;
}

beforeEach(() => {
  (findSchoolById as jest.Mock).mockResolvedValue({ id: 'school-1', name: 'Test School', identity_config: {} });
});

describe('a receipt', () => {
  it('shows a convenience fee and a refund beside the payment, apart from it', async () => {
    const html = await rendered(payment({ convenience_fee_kobo: '55838', refunded_kobo: '100050' }));
    expect(html).toContain('₦30,000.00');
    expect(html).toMatch(/convenience fee to the payment provider \(not part of the school fees; not refundable\)<\/td>\s*<td class="amount-cell">₦558\.38</);
    expect(html).toMatch(/Refunded against this payment<\/td>\s*<td class="amount-cell">&minus;₦1,000\.50</);
  });

  it('a payment with neither shows neither', async () => {
    const html = await rendered(payment({}));
    // The control: the same receipt, rendered, with its payment on it.
    expect(html).toContain('₦30,000.00');
    expect(html).not.toContain('convenience fee');
    expect(html).not.toContain('Refunded against this payment');
  });
});
