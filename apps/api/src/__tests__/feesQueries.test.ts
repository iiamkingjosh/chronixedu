import pool from '../db/client';
import {
  insertFeeStructure,
  listFeeStructures,
  generateInvoices,
  getInvoiceByStudent,
  getInvoiceById,
  listInvoices,
  getOutstandingBalances,
  getCollectionSummary,
  recordPayment,
  getPaymentById,
  deriveStatus,
} from '../db/queries/fees';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;
const mockConnect = (pool as unknown as { connect: jest.Mock }).connect;

beforeEach(() => jest.clearAllMocks());

function makeMockClient() {
  return { query: jest.fn(), release: jest.fn() };
}

describe('insertFeeStructure', () => {
  it('inserts a fee structure row and returns it', async () => {
    const row = {
      id: 'fs-1',
      school_id: 'school-1',
      class_id: 'class-1',
      term_id: 'term-1',
      component_name: 'Tuition',
      amount: '50000.00',
      is_mandatory: true,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await insertFeeStructure('school-1', {
      class_id: 'class-1',
      term_id: 'term-1',
      component_name: 'Tuition',
      amount: 50000,
      is_mandatory: true,
    });

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO fee_structures'),
      ['school-1', 'class-1', 'term-1', 'Tuition', 50000, true]
    );
  });

  it('inserts with class_id null for school-wide fees', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fs-2' }] });

    await insertFeeStructure('school-1', {
      class_id: null,
      term_id: 'term-1',
      component_name: 'Sports Levy',
      amount: 1500,
      is_mandatory: false,
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      ['school-1', null, 'term-1', 'Sports Levy', 1500, false]
    );
  });
});

describe('listFeeStructures', () => {
  it('lists structures for a term without a class filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listFeeStructures('school-1', 'term-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE school_id = $1 AND term_id = $2'),
      ['school-1', 'term-1']
    );
  });

  it('includes class-specific and school-wide rows when class_id is given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listFeeStructures('school-1', 'term-1', 'class-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('(class_id = $3 OR class_id IS NULL)'),
      ['school-1', 'term-1', 'class-1']
    );
  });
});

describe('generateInvoices', () => {
  it('upserts an invoice per enrolled student, summing mandatory fee_structures for the class or school-wide', async () => {
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ session_id: 'session-1' }] }) // term lookup
      .mockResolvedValueOnce({ rows: [{ total: '15000.00' }] }) // sum fee_structures
      .mockResolvedValueOnce({ rows: [{ id: 'student-1' }, { id: 'student-2' }] }) // enrolled students
      .mockResolvedValueOnce({
        rows: [{ id: 'inv-1', school_id: 'school-1', student_id: 'student-1', term_id: 'term-1', total_amount: '15000.00', amount_paid: '0.00', balance: '15000.00', status: 'unpaid', created_at: '', updated_at: null }],
      }) // upsert student-1
      .mockResolvedValueOnce({
        rows: [{ id: 'inv-2', school_id: 'school-1', student_id: 'student-2', term_id: 'term-1', total_amount: '15000.00', amount_paid: '5000.00', balance: '10000.00', status: 'partial', created_at: '', updated_at: '' }],
      }) // upsert student-2
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await generateInvoices('school-1', 'term-1', 'class-1');

    expect(result).toHaveLength(2);
    expect(result![0].status).toBe('unpaid');
    expect(result![1].status).toBe('partial');

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('is_mandatory = TRUE'),
      ['school-1', 'term-1', 'class-1']
    );
    expect(client.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('ON CONFLICT (student_id, term_id) DO UPDATE'),
      ['school-1', 'student-1', 'term-1', 15000]
    );
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('returns null when the term does not belong to the school', async () => {
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // term lookup - not found
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await generateInvoices('school-1', 'missing-term', 'class-1');

    expect(result).toBeNull();
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back and rethrows on error', async () => {
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('db error')); // term lookup fails

    await expect(generateInvoices('school-1', 'term-1', 'class-1')).rejects.toThrow('db error');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('getInvoiceByStudent', () => {
  it('returns the invoice with its payment history', async () => {
    const invoiceRow = {
      id: 'inv-1', school_id: 'school-1', student_id: 'student-1', term_id: 'term-1',
      total_amount: '15000.00', amount_paid: '5000.00', balance: '10000.00', status: 'partial',
      created_at: '', updated_at: '',
    };
    const paymentRow = {
      id: 'pay-1', invoice_id: 'inv-1', school_id: 'school-1', amount: '5000.00',
      payment_date: '2026-01-10', method: 'cash', reference: 'RCT-1', paystack_reference: null,
      recorded_by: 'user-1', created_at: '',
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [invoiceRow] })
      .mockResolvedValueOnce({ rows: [paymentRow] });

    const result = await getInvoiceByStudent('school-1', 'student-1', 'term-1');

    expect(result).toEqual({ ...invoiceRow, payments: [paymentRow] });
    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM fee_invoices'),
      ['school-1', 'student-1', 'term-1']
    );
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM payments'),
      ['inv-1']
    );
  });

  it('returns null when no invoice exists for the student/term', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getInvoiceByStudent('school-1', 'student-1', 'term-1');

    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('getInvoiceById', () => {
  it('returns the invoice when it belongs to the school', async () => {
    const invoiceRow = {
      id: 'inv-1', school_id: 'school-1', student_id: 'student-1', term_id: 'term-1',
      total_amount: '15000.00', amount_paid: '5000.00', balance: '10000.00', status: 'partial',
      created_at: '', updated_at: '',
    };
    mockQuery.mockResolvedValueOnce({ rows: [invoiceRow] });

    const result = await getInvoiceById('school-1', 'inv-1');

    expect(result).toEqual(invoiceRow);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM fee_invoices'),
      ['inv-1', 'school-1']
    );
  });

  it('returns null when no invoice exists for the school', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getInvoiceById('school-1', 'inv-1');

    expect(result).toBeNull();
  });
});

describe('listInvoices', () => {
  it('lists invoices for a term with student details', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listInvoices('school-1', 'term-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM fee_invoices'),
      ['school-1', 'term-1']
    );
  });

  it('filters by class_id when given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listInvoices('school-1', 'term-1', { classId: 'class-1' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('sc.class_id = $3'),
      ['school-1', 'term-1', 'class-1']
    );
  });

  it('filters by status when given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listInvoices('school-1', 'term-1', { status: 'unpaid' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("fi.status = $3::chronixedu_invoice_status"),
      ['school-1', 'term-1', 'unpaid']
    );
  });

  it('filters by both class_id and status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await listInvoices('school-1', 'term-1', { classId: 'class-1', status: 'paid' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      ['school-1', 'term-1', 'class-1', 'paid']
    );
  });
});

describe('getOutstandingBalances', () => {
  it('lists students with a positive balance for the term', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getOutstandingBalances('school-1', 'term-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('fi.balance > 0'),
      ['school-1', 'term-1']
    );
  });

  it('filters by class_id when given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getOutstandingBalances('school-1', 'term-1', 'class-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('sc.class_id = $3'),
      ['school-1', 'term-1', 'class-1']
    );
  });
});

describe('getCollectionSummary', () => {
  it('aggregates totals and status counts for a term', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_expected: '45000.00', total_collected: '15000.00', total_outstanding: '30000.00', unpaid: '1', partial: '1', paid: '1' }],
    });

    const result = await getCollectionSummary('school-1', 'term-1');

    expect(result).toEqual({
      total_expected: 45000,
      total_collected: 15000,
      total_outstanding: 30000,
      counts: { unpaid: 1, partial: 1, paid: 1 },
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM fee_invoices'),
      ['school-1', 'term-1']
    );
  });

  it('filters by class_id when given', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_expected: '0', total_collected: '0', total_outstanding: '0', unpaid: '0', partial: '0', paid: '0' }],
    });

    await getCollectionSummary('school-1', 'term-1', 'class-1');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      ['school-1', 'term-1', 'class-1']
    );
  });
});

describe('deriveStatus', () => {
  it('returns unpaid when nothing has been paid', () => {
    expect(deriveStatus(15000, 0)).toBe('unpaid');
  });

  it('returns partial when some but not all has been paid', () => {
    expect(deriveStatus(15000, 7500)).toBe('partial');
  });

  it('returns paid when amount_paid equals total_amount', () => {
    expect(deriveStatus(15000, 15000)).toBe('paid');
  });

  it('returns paid on overpayment', () => {
    expect(deriveStatus(15000, 20000)).toBe('paid');
  });
});

describe('recordPayment', () => {
  it('inserts a payment and recomputes amount_paid/balance/status on the invoice', async () => {
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    const paymentRow = {
      id: 'pay-1', invoice_id: 'inv-1', school_id: 'school-1', amount: '10000.00',
      payment_date: '2026-06-11', method: 'cash', reference: 'RCT-2', paystack_reference: null,
      recorded_by: 'user-1', created_at: '',
    };
    const updatedInvoice = {
      id: 'inv-1', school_id: 'school-1', student_id: 'student-1', term_id: 'term-1',
      total_amount: '15000.00', amount_paid: '15000.00', balance: '0.00', status: 'paid',
      created_at: '', updated_at: '',
    };

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ total_amount: '15000.00', amount_paid: '5000.00' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [paymentRow] }) // INSERT payment
      .mockResolvedValueOnce({ rows: [updatedInvoice] }) // UPDATE invoice
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await recordPayment('school-1', 'inv-1', {
      amount: 10000,
      method: 'cash',
      reference: 'RCT-2',
      recorded_by: 'user-1',
    });

    expect(result).toEqual({ payment: paymentRow, invoice: updatedInvoice });

    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FOR UPDATE'),
      ['inv-1', 'school-1']
    );
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('UPDATE fee_invoices'),
      [15000, 0, 'paid', 'inv-1']
    );
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('returns null when the invoice does not belong to the school', async () => {
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE - not found
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const result = await recordPayment('school-1', 'missing-inv', { amount: 1000, method: 'cash' });

    expect(result).toBeNull();
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back and rethrows on error', async () => {
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('db error')); // SELECT FOR UPDATE fails

    await expect(recordPayment('school-1', 'inv-1', { amount: 1000, method: 'cash' })).rejects.toThrow('db error');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('getPaymentById', () => {
  it('returns the payment with invoice/student/term details for the school', async () => {
    const row = {
      id: 'pay-1', invoice_id: 'inv-1', school_id: 'school-1', amount: '10000.00',
      payment_date: '2026-06-11', method: 'cash', reference: 'RCT-2', paystack_reference: null,
      recorded_by: 'user-1', created_at: '',
      total_amount: '15000.00', amount_paid: '15000.00', balance: '0.00', invoice_status: 'paid',
      first_name: 'Amina', last_name: 'Okonkwo', admission_no: 'CE/2026/001',
      class_name: 'JSS 1A', term_name: 'First Term', session_name: '2025/2026',
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await getPaymentById('school-1', 'pay-1');

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM payments'),
      ['pay-1', 'school-1']
    );
  });

  it('returns null when no payment exists for the school', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPaymentById('school-1', 'pay-1');

    expect(result).toBeNull();
  });
});
