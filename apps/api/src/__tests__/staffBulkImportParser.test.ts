import ExcelJS from 'exceljs';
import { parseStaffBulkImportFile, StaffBulkImportParseError } from '../services/staffBulkImportParser';

async function xlsxBuffer(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Staff');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const HEADERS = ['Email', 'First Name', 'Last Name', 'Role', 'Title', 'Phone', 'Teaching Mode'];

describe('parseStaffBulkImportFile', () => {
  it('parses a well-formed teacher row from .xlsx', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['Chidi@Example.COM', 'Chidi', 'Okafor', 'Teacher', 'Mr.', '08012345678', 'Subject']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_number: 2,
      email: 'chidi@example.com',
      first_name: 'Chidi',
      last_name: 'Okafor',
      role: 'teacher',
      title: 'Mr.',
      phone: '08012345678',
      teacher_mode: 'subject',
    });
  });

  it('parses the same shape from .csv', async () => {
    const csv = 'Email,First Name,Last Name,Role,Title,Phone,Teaching Mode\nbimpe@example.com,Bimpe,Ade,Registrar,,,\n';
    const rows = await parseStaffBulkImportFile(Buffer.from(csv), 'staff.csv');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ row_number: 2, email: 'bimpe@example.com', role: 'registrar', title: null, teacher_mode: null });
  });

  it('lowercases email and role, leaves title/phone as-is', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['Bursar@Example.com', 'Femi', 'Ola', 'BURSAR', 'Dr.', '', '']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows[0].email).toBe('bursar@example.com');
    expect(rows[0].role).toBe('bursar');
    expect(rows[0].title).toBe('Dr.');
  });

  it('assigns the real sheet row number and skips fully blank rows without compacting', async () => {
    const buffer = await xlsxBuffer(HEADERS, [
      ['a@example.com', 'A', 'One', 'teacher', '', '', 'class'],
      ['', '', '', '', '', '', ''],
      ['b@example.com', 'B', 'Two', 'teacher', '', '', 'class'],
    ]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows.map(r => r.row_number)).toEqual([2, 4]);
  });

  it('does not drop a row that has content but is missing a required field', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['', 'A', 'One', 'teacher', '', '', 'class']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: '', first_name: 'A' });
  });

  it('throws StaffBulkImportParseError when a required column is missing', async () => {
    const buffer = await xlsxBuffer(['Email', 'First Name'], [['a@example.com', 'A']]); // missing Last Name, Role
    await expect(parseStaffBulkImportFile(buffer, 'staff.xlsx')).rejects.toThrow(StaffBulkImportParseError);
  });

  it('matches headers case-insensitively', async () => {
    const buffer = await xlsxBuffer(['email', 'FIRST NAME', 'last name', 'role'], [['a@example.com', 'A', 'One', 'teacher']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows[0]).toMatchObject({ email: 'a@example.com', first_name: 'A', last_name: 'One', role: 'teacher' });
  });

  it('leaves teacher_mode null when the column is blank, not the empty string', async () => {
    const buffer = await xlsxBuffer(HEADERS, [['a@example.com', 'A', 'One', 'principal', '', '', '']]);
    const rows = await parseStaffBulkImportFile(buffer, 'staff.xlsx');
    expect(rows[0].teacher_mode).toBeNull();
  });
});
