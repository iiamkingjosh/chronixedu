import ExcelJS from 'exceljs';
import { generateBulkImportResultsFile } from '../services/bulkImportResults';

describe('generateBulkImportResultsFile', () => {
  it('produces a workbook with Summary, Students Created, and New Parent Accounts sheets', async () => {
    const buffer = await generateBulkImportResultsFile(
      [{ row_number: 1, first_name: 'Ada', last_name: 'Bello', admission_no: 'SCH/2026/0001', email: 'ada@school.internal' }],
      [{ first_name: 'Bisi', last_name: 'Bello', email: 'bisi@example.com' }]
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Students Created', 'New Parent Accounts']);

    const studentsSheet = workbook.getWorksheet('Students Created')!;
    expect(studentsSheet.getRow(2).getCell(4).value).toBe('SCH/2026/0001');

    const parentsSheet = workbook.getWorksheet('New Parent Accounts')!;
    expect(parentsSheet.getRow(2).getCell(3).value).toBe('bisi@example.com');
  });

  it('mentions the fixed password once in the Summary sheet', async () => {
    const buffer = await generateBulkImportResultsFile([], []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const summarySheet = workbook.getWorksheet('Summary')!;
    const allText = [1, 2, 3].map(n => String(summarySheet.getRow(n).getCell(1).value ?? '')).join(' ');
    expect(allText).toContain('Password2$');
  });
});
