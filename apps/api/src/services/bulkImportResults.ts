import ExcelJS from 'exceljs';

export interface CreatedStudentRecord {
  row_number: number;
  first_name: string;
  last_name: string;
  admission_no: string;
  email: string;
}

export interface CreatedParentRecord {
  first_name: string;
  last_name: string;
  email: string;
}

export async function generateBulkImportResultsFile(
  createdStudents: CreatedStudentRecord[],
  newParents: CreatedParentRecord[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Bulk Import Results']);
  summary.addRow([`${createdStudents.length} student(s) and ${newParents.length} new parent account(s) created.`]);
  summary.addRow(['All accounts use the temporary password Password2$ — users are required to change it on first login.']);

  const studentsSheet = workbook.addWorksheet('Students Created');
  studentsSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'First Name', key: 'first_name', width: 20 },
    { header: 'Last Name', key: 'last_name', width: 20 },
    { header: 'Admission No.', key: 'admission_no', width: 20 },
    { header: 'Email', key: 'email', width: 32 },
  ];
  createdStudents.forEach(s => studentsSheet.addRow(s));

  const parentsSheet = workbook.addWorksheet('New Parent Accounts');
  parentsSheet.columns = [
    { header: 'First Name', key: 'first_name', width: 20 },
    { header: 'Last Name', key: 'last_name', width: 20 },
    { header: 'Email', key: 'email', width: 32 },
  ];
  newParents.forEach(p => parentsSheet.addRow(p));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
