import ExcelJS from 'exceljs';
import { parseRosterBulkImportFile, RosterBulkImportParseError } from '../services/rosterBulkImportParser';

async function makeWorkbookBuffer(sheets: { name: string; headers: string[]; rows: (string | number)[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = workbook.addWorksheet(s.name);
    sheet.addRow(s.headers);
    s.rows.forEach(r => sheet.addRow(r));
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const CLASS_HEADERS = ['Name', 'Level', 'Stream', 'Form Teacher Email'];
const SUBJECT_HEADERS = ['Name', 'Code'];
const ASSIGNMENT_HEADERS = ['Teacher Email', 'Class Name', 'Subject Code'];

function emptySheets(overrides: Partial<Record<'Classes' | 'Subjects' | 'Teacher Assignments', (string | number)[][]>> = {}) {
  return [
    { name: 'Classes', headers: CLASS_HEADERS, rows: overrides['Classes'] ?? [] },
    { name: 'Subjects', headers: SUBJECT_HEADERS, rows: overrides['Subjects'] ?? [] },
    { name: 'Teacher Assignments', headers: ASSIGNMENT_HEADERS, rows: overrides['Teacher Assignments'] ?? [] },
  ];
}

describe('parseRosterBulkImportFile', () => {
  it('rejects a non-.xlsx filename', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets());
    await expect(parseRosterBulkImportFile(buffer, 'roster.csv')).rejects.toThrow(RosterBulkImportParseError);
  });

  it('parses a well-formed Classes row', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['JSS 1A', 'JSS1', '', 'chidi@example.com']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]).toMatchObject({
      row_number: 2,
      name: 'JSS 1A',
      level: 'JSS1',
      stream: null,
      form_teacher_email: 'chidi@example.com',
    });
  });

  it('lowercases form_teacher_email and teacher_email, uppercases subject/assignment codes', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['JSS 1A', 'JSS1', '', 'Chidi@Example.COM']],
      Subjects: [['Mathematics', 'mth']],
      'Teacher Assignments': [['Chidi@Example.COM', 'JSS 1A', 'mth']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes[0].form_teacher_email).toBe('chidi@example.com');
    expect(result.subjects[0].code).toBe('MTH');
    expect(result.assignments[0].teacher_email).toBe('chidi@example.com');
    expect(result.assignments[0].subject_code).toBe('MTH');
  });

  it('assigns the real sheet row number and skips fully blank rows without compacting', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['JSS 1A', 'JSS1', '', ''], ['', '', '', ''], ['JSS 1B', 'JSS1', '', '']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes.map(c => c.row_number)).toEqual([2, 4]);
  });

  it('does not drop a row that has content but is missing a required field', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Classes: [['', 'JSS1', '', '']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0]).toMatchObject({ name: '', level: 'JSS1' });
  });

  it('parses Subjects and Teacher Assignments sheets independently of Classes', async () => {
    const buffer = await makeWorkbookBuffer(emptySheets({
      Subjects: [['Mathematics', 'MTH'], ['English Language', 'ENG']],
      'Teacher Assignments': [['teacher@example.com', 'JSS 1A', 'MTH']],
    }));
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.subjects).toHaveLength(2);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({
      row_number: 2,
      teacher_email: 'teacher@example.com',
      class_name: 'JSS 1A',
      subject_code: 'MTH',
    });
  });

  it('throws RosterBulkImportParseError when a required sheet is missing entirely', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(CLASS_HEADERS);
    // Subjects and Teacher Assignments sheets absent entirely.
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await expect(parseRosterBulkImportFile(buffer, 'roster.xlsx')).rejects.toThrow(RosterBulkImportParseError);
  });

  it('throws RosterBulkImportParseError when the Classes sheet is missing a required column', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(['Name']); // missing Level
    workbook.addWorksheet('Subjects').addRow(SUBJECT_HEADERS);
    workbook.addWorksheet('Teacher Assignments').addRow(ASSIGNMENT_HEADERS);
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await expect(parseRosterBulkImportFile(buffer, 'roster.xlsx')).rejects.toThrow(RosterBulkImportParseError);
  });

  it('matches headers case-insensitively', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Classes').addRow(['name', 'LEVEL', 'stream', 'form teacher email']);
    workbook.getWorksheet('Classes')!.addRow(['JSS 1A', 'JSS1', '', '']);
    workbook.addWorksheet('Subjects').addRow(SUBJECT_HEADERS);
    workbook.addWorksheet('Teacher Assignments').addRow(ASSIGNMENT_HEADERS);
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await parseRosterBulkImportFile(buffer, 'roster.xlsx');
    expect(result.classes[0]).toMatchObject({ name: 'JSS 1A', level: 'JSS1' });
  });
});
