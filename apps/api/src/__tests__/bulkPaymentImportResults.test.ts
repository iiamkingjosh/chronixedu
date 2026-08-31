import ExcelJS from 'exceljs';
import { generateBulkPaymentImportResultsFile } from '../services/bulkPaymentImportResults';

describe('generateBulkPaymentImportResultsFile', () => {
  it('produces a workbook with Summary, Payments Recorded, and Payments Failed sheets', async () => {
    const buffer = await generateBulkPaymentImportResultsFile(
      [{ row_number: 2, admission_no: 'SCH/2024/0001', student_name: 'Ada Obi', amount: 10000, method: 'cash' }],
      [{ row_number: 3, admission_no: 'SCH/2024/0002', amount: '999999', method: 'cash', reason: 'Amount exceeds the outstanding balance.' }]
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Payments Recorded', 'Payments Failed']);
    expect(workbook.getWorksheet('Payments Recorded')!.getRow(2).getCell(2).value).toBe('SCH/2024/0001');
    expect(workbook.getWorksheet('Payments Failed')!.getRow(2).getCell(5).value).toBe('Amount exceeds the outstanding balance.');
  });

  it('handles all-empty inputs without error', async () => {
    const buffer = await generateBulkPaymentImportResultsFile([], []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(3);
  });
});
