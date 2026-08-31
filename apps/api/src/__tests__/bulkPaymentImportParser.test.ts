import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { parseBulkPaymentImportFile, BulkPaymentImportParseError } from '../services/bulkPaymentImportParser';

async function xlsxBuffer(headers: string[], rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Payments');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Admission Number', 'Amount', 'Method', 'Payment Date', 'Reference'];

describe('parseBulkPaymentImportFile', () => {
  it('parses a well-formed row from .xlsx', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['SCH/2024/0001', 50000, 'Cash', '2026-01-15', 'Receipt #221']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_number: 2,
      admission_no: 'SCH/2024/0001',
      amount: '50000',
      method: 'cash',
      payment_date: '2026-01-15',
      reference: 'Receipt #221',
    });
  });

  it('parses the same shape from .csv', async () => {
    const csv = 'Admission Number,Amount,Method,Payment Date,Reference\nSCH/2024/0002,30000,bank_transfer,,\n';
    const rows = await parseBulkPaymentImportFile(Buffer.from(csv), 'payments.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admission_no: 'SCH/2024/0002', amount: '30000', method: 'bank_transfer', payment_date: null, reference: null });
  });

  it('lowercases method, leaves admission_no and reference as-is', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['sch/2024/0003', 1000, 'WAIVER', '', '']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows[0].admission_no).toBe('sch/2024/0003');
    expect(rows[0].method).toBe('waiver');
  });

  it('assigns the real sheet row number and skips fully blank rows without compacting', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['SCH/2024/0001', 1000, 'cash', '', ''],
      ['', '', '', '', ''],
      ['SCH/2024/0002', 2000, 'cash', '', ''],
    ]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows.map(r => r.row_number)).toEqual([2, 4]);
  });

  it('does not drop a row that has content but is missing a required field', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['', 1000, 'cash', '', '']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admission_no: '', amount: '1000' });
  });

  it('throws BulkPaymentImportParseError when a required column is missing', async () => {
    const buffer = await xlsxBuffer(['Admission Number', 'Amount'], [['SCH/2024/0001', 1000]]); // missing Method
    await expect(parseBulkPaymentImportFile(buffer, 'payments.xlsx')).rejects.toThrow(BulkPaymentImportParseError);
  });

  it('matches headers case-insensitively', async () => {
    const buffer = await xlsxBuffer(['admission number', 'AMOUNT', 'method'], [['SCH/2024/0001', 1000, 'cash']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows[0]).toMatchObject({ admission_no: 'SCH/2024/0001', amount: '1000', method: 'cash' });
  });

  it('handles a numeric Amount cell (not just text)', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['SCH/2024/0001', 12345.5, 'cash', '', '']]);
    const rows = await parseBulkPaymentImportFile(buffer, 'payments.xlsx');
    expect(rows[0].amount).toBe('12345.5');
  });
});
