import ExcelJS from 'exceljs';

export interface CreatedClassRecord {
  row_number: number;
  name: string;
  level: string;
}

export interface CreatedSubjectRecord {
  row_number: number;
  name: string;
  code: string;
}

export interface CreatedAssignmentRecord {
  row_number: number;
  teacher_email: string;
  class_name: string;
  subject_code: string;
}

export async function generateRosterBulkImportResultsFile(
  classes: CreatedClassRecord[],
  subjects: CreatedSubjectRecord[],
  assignments: CreatedAssignmentRecord[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Roster Bulk Import Results']);
  summary.addRow([`${classes.length} class(es), ${subjects.length} subject(s), and ${assignments.length} teacher assignment(s) created.`]);

  const classesSheet = workbook.addWorksheet('Classes Created');
  classesSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Level', key: 'level', width: 16 },
  ];
  classes.forEach(c => classesSheet.addRow(c));

  const subjectsSheet = workbook.addWorksheet('Subjects Created');
  subjectsSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Code', key: 'code', width: 12 },
  ];
  subjects.forEach(s => subjectsSheet.addRow(s));

  const assignmentsSheet = workbook.addWorksheet('Assignments Created');
  assignmentsSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Teacher Email', key: 'teacher_email', width: 28 },
    { header: 'Class Name', key: 'class_name', width: 20 },
    { header: 'Subject Code', key: 'subject_code', width: 14 },
  ];
  assignments.forEach(a => assignmentsSheet.addRow(a));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
