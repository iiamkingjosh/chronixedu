import ExcelJS from 'exceljs';
import { generateRosterBulkImportResultsFile } from '../services/rosterBulkImportResults';

describe('generateRosterBulkImportResultsFile', () => {
  it('produces a workbook with Summary, Classes Created, Subjects Created, and Assignments Created sheets', async () => {
    const buffer = await generateRosterBulkImportResultsFile(
      [{ row_number: 2, name: 'JSS 1A', level: 'JSS1' }],
      [{ row_number: 2, name: 'Mathematics', code: 'MTH' }],
      [{ row_number: 2, teacher_email: 'teacher@example.com', class_name: 'JSS 1A', subject_code: 'MTH' }]
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

    expect(workbook.worksheets.map(w => w.name)).toEqual(['Summary', 'Classes Created', 'Subjects Created', 'Assignments Created']);
    expect(workbook.getWorksheet('Classes Created')!.getRow(2).getCell(2).value).toBe('JSS 1A');
    expect(workbook.getWorksheet('Subjects Created')!.getRow(2).getCell(3).value).toBe('MTH');
    expect(workbook.getWorksheet('Assignments Created')!.getRow(2).getCell(2).value).toBe('teacher@example.com');
  });

  it('handles all-empty inputs without error', async () => {
    const buffer = await generateRosterBulkImportResultsFile([], [], []);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    expect(workbook.worksheets).toHaveLength(4);
  });
});
