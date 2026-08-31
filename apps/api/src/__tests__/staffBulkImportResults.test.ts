import ExcelJS from 'exceljs';
import { generateStaffBulkImportResultsFile } from '../services/staffBulkImportResults';

describe('generateStaffBulkImportResultsFile', () => {
  it('produces a workbook with a Summary sheet, a Staff Created sheet, and a Rows Failed sheet', async () => {
    const buffer = await generateStaffBulkImportResultsFile(
      [{ row_number: 2, first_name: 'Chidi', last_name: 'Okafor', email: 'chidi@example.com', role: 'teacher' }],
      [{ row_number: 3, first_name: 'Bad', last_name: 'Row', email: 'not-an-email', role: 'teacher', reason: 'Email is invalid.' }]
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Staff Created', 'Rows Failed']);
    expect(workbook.getWorksheet('Staff Created')!.getRow(2).getCell(5).value).toBe('teacher');

    const failedSheet = workbook.getWorksheet('Rows Failed')!;
    expect(failedSheet.getRow(2).getCell(1).value).toBe(3);
    expect(failedSheet.getRow(2).getCell(2).value).toBe('not-an-email');
    expect(failedSheet.getRow(2).getCell(6).value).toBe('Email is invalid.');
  });

  it('handles empty input without error', async () => {
    const buffer = await generateStaffBulkImportResultsFile([], []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(3);
  });
});
