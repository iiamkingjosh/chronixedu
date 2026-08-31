import ExcelJS from 'exceljs';
import { generateStaffBulkImportResultsFile } from '../services/staffBulkImportResults';

describe('generateStaffBulkImportResultsFile', () => {
  it('produces a workbook with a Summary sheet and a Staff Created sheet', async () => {
    const buffer = await generateStaffBulkImportResultsFile([
      { row_number: 2, first_name: 'Chidi', last_name: 'Okafor', email: 'chidi@example.com', role: 'teacher' },
    ]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Staff Created']);
    expect(workbook.getWorksheet('Staff Created')!.getRow(2).getCell(5).value).toBe('teacher');
  });

  it('handles an empty input without error', async () => {
    const buffer = await generateStaffBulkImportResultsFile([]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(2);
  });
});
