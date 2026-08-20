import ExcelJS from 'exceljs';

export interface ParsedClassRow {
  row_number: number;
  name: string;
  level: string;
  stream: string | null;
  form_teacher_email: string | null;
}

export interface ParsedSubjectRow {
  row_number: number;
  name: string;
  code: string;
}

export interface ParsedAssignmentRow {
  row_number: number;
  teacher_email: string;
  class_name: string;
  subject_code: string;
}

export interface ParsedRosterWorkbook {
  classes: ParsedClassRow[];
  subjects: ParsedSubjectRow[];
  assignments: ParsedAssignmentRow[];
}

export class RosterBulkImportParseError extends Error {}

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: unknown }).text).trim() || null;
  }
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return String((value as { result: unknown }).result).trim() || null;
  }
  const str = String(value).trim();
  return str === '' ? null : str;
}

/** Shared row-extraction for all three sheets — same header-matching,
 *  blank-row-skipping, and real-sheet-row-numbering rules apply to each. */
function parseSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  columnMap: Record<string, string>,
  requiredFields: string[]
): Record<string, string | null>[] {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new RosterBulkImportParseError(`The file is missing the required "${sheetName}" sheet.`);
  }

  const headerRow = sheet.getRow(1);
  const columnIndexToField = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellText(cell.value)?.toLowerCase();
    if (header && columnMap[header]) {
      columnIndexToField.set(colNumber, columnMap[header]);
    }
  });

  const foundFields = new Set(columnIndexToField.values());
  const missing = requiredFields.filter(f => !foundFields.has(f));
  if (missing.length > 0) {
    throw new RosterBulkImportParseError(`The "${sheetName}" sheet is missing required column(s): ${missing.join(', ')}`);
  }

  const rows: Record<string, string | null>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string | null> = {};
    columnIndexToField.forEach((field, colNumber) => {
      raw[field] = cellText(row.getCell(colNumber).value);
    });
    const hasAnyContent = Object.values(raw).some(v => v !== null);
    if (!hasAnyContent) return;
    raw.row_number = String(rowNumber);
    rows.push(raw);
  });

  return rows;
}

const CLASS_COLUMN_MAP: Record<string, string> = {
  'name': 'name',
  'level': 'level',
  'stream': 'stream',
  'form teacher email': 'form_teacher_email',
};

const SUBJECT_COLUMN_MAP: Record<string, string> = {
  'name': 'name',
  'code': 'code',
};

const ASSIGNMENT_COLUMN_MAP: Record<string, string> = {
  'teacher email': 'teacher_email',
  'class name': 'class_name',
  'subject code': 'subject_code',
};

export async function parseRosterBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedRosterWorkbook> {
  if (!filename.toLowerCase().endsWith('.xlsx')) {
    throw new RosterBulkImportParseError('Only .xlsx files are supported for Roster bulk import.');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const classRaws = parseSheet(workbook, 'Classes', CLASS_COLUMN_MAP, ['name', 'level']);
  const subjectRaws = parseSheet(workbook, 'Subjects', SUBJECT_COLUMN_MAP, ['name', 'code']);
  const assignmentRaws = parseSheet(workbook, 'Teacher Assignments', ASSIGNMENT_COLUMN_MAP, ['teacher_email', 'class_name', 'subject_code']);

  const classes: ParsedClassRow[] = classRaws.map(raw => ({
    row_number: Number(raw.row_number),
    name: raw.name ?? '',
    level: raw.level ?? '',
    stream: raw.stream ?? null,
    form_teacher_email: raw.form_teacher_email ? raw.form_teacher_email.toLowerCase() : null,
  }));

  const subjects: ParsedSubjectRow[] = subjectRaws.map(raw => ({
    row_number: Number(raw.row_number),
    name: raw.name ?? '',
    code: raw.code ? raw.code.toUpperCase() : '',
  }));

  const assignments: ParsedAssignmentRow[] = assignmentRaws.map(raw => ({
    row_number: Number(raw.row_number),
    teacher_email: raw.teacher_email ? raw.teacher_email.toLowerCase() : '',
    class_name: raw.class_name ?? '',
    subject_code: raw.subject_code ? raw.subject_code.toUpperCase() : '',
  }));

  return { classes, subjects, assignments };
}
