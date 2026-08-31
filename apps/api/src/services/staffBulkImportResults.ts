import ExcelJS from 'exceljs';

export interface CreatedStaffRecord {
  row_number: number;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
}

export async function generateStaffBulkImportResultsFile(created: CreatedStaffRecord[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Staff Bulk Import Results']);
  summary.addRow([`${created.length} staff account(s) created.`]);
  summary.addRow(['All accounts use the temporary password Password2$ — users are required to change it on first login.']);

  const staffSheet = workbook.addWorksheet('Staff Created');
  staffSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'First Name', key: 'first_name', width: 20 },
    { header: 'Last Name', key: 'last_name', width: 20 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Role', key: 'role', width: 14 },
  ];
  created.forEach(s => staffSheet.addRow(s));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
