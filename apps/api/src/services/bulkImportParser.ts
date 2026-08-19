import ExcelJS from 'exceljs';
import { Readable } from 'stream';

export interface ParsedParentRow {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  relationship_type: string | null;
  is_primary_contact: boolean;
}

export interface ParsedStudentRow {
  row_number: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  dob: string | null;
  gender: string | null;
  address: string | null;
  blood_group: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  parent1: ParsedParentRow | null;
  parent2: ParsedParentRow | null;
}

export class BulkImportParseError extends Error {}

const REQUIRED_HEADERS = ['first name', 'last name'];

const COLUMN_MAP: Record<string, string> = {
  'first name': 'first_name',
  'last name': 'last_name',
  'email': 'email',
  'phone': 'phone',
  'date of birth (yyyy-mm-dd)': 'dob',
  'gender': 'gender',
  'address': 'address',
  'blood group': 'blood_group',
  'emergency contact name': 'emergency_contact_name',
  'emergency contact phone': 'emergency_contact_phone',
  'parent 1 first name': 'parent1_first_name',
  'parent 1 last name': 'parent1_last_name',
  'parent 1 email': 'parent1_email',
  'parent 1 phone': 'parent1_phone',
  'parent 1 relationship': 'parent1_relationship_type',
  'parent 1 primary contact (yes/no)': 'parent1_is_primary_contact',
  'parent 2 first name': 'parent2_first_name',
  'parent 2 last name': 'parent2_last_name',
  'parent 2 email': 'parent2_email',
  'parent 2 phone': 'parent2_phone',
  'parent 2 relationship': 'parent2_relationship_type',
  'parent 2 primary contact (yes/no)': 'parent2_is_primary_contact',
};

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // Excel auto-types typed dates as JS Date objects — format as YYYY-MM-DD
    // to match the expected dob format, rather than a garbled Date.toString().
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object' && value !== null && 'text' in (value as Record<string, unknown>)) {
    return String((value as { text: unknown }).text).trim() || null;
  }
  if (typeof value === 'object' && value !== null && 'result' in (value as Record<string, unknown>)) {
    return String((value as { result: unknown }).result).trim() || null;
  }
  const str = String(value).trim();
  return str === '' ? null : str;
}

function buildParent(raw: Record<string, string | null>, prefix: 'parent1' | 'parent2'): ParsedParentRow | null {
  const first_name = raw[`${prefix}_first_name`] ?? null;
  const last_name = raw[`${prefix}_last_name`] ?? null;
  const email = raw[`${prefix}_email`] ?? null;
  const phone = raw[`${prefix}_phone`] ?? null;
  const relationship_type = raw[`${prefix}_relationship_type`] ?? null;
  const isPrimaryRaw = raw[`${prefix}_is_primary_contact`] ?? null;
  const hasAnyField = !!(first_name || last_name || email || phone || relationship_type || isPrimaryRaw);
  if (!hasAnyField) return null;
  return {
    first_name,
    last_name,
    email,
    phone,
    relationship_type,
    is_primary_contact: !!isPrimaryRaw && /^y(es)?$/i.test(isPrimaryRaw),
  };
}

async function worksheetFromBuffer(buffer: Buffer, filename: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv') {
    return workbook.csv.read(Readable.from(buffer));
  }
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BulkImportParseError('The file has no worksheet.');
  return sheet;
}

export async function parseBulkImportFile(buffer: Buffer, filename: string): Promise<ParsedStudentRow[]> {
  const sheet = await worksheetFromBuffer(buffer, filename);

  const headerRow = sheet.getRow(1);
  const columnIndexToField = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellText(cell.value)?.toLowerCase();
    if (header && COLUMN_MAP[header]) {
      columnIndexToField.set(colNumber, COLUMN_MAP[header]);
    }
  });

  const foundFields = new Set(columnIndexToField.values());
  const missing = REQUIRED_HEADERS.filter(h => !foundFields.has(COLUMN_MAP[h]));
  if (missing.length > 0) {
    throw new BulkImportParseError(`The file is missing required column(s): ${missing.map(h => COLUMN_MAP[h]).join(', ')}`);
  }

  const rows: ParsedStudentRow[] = [];
  let dataRowNumber = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string | null> = {};
    columnIndexToField.forEach((field, colNumber) => {
      raw[field] = cellText(row.getCell(colNumber).value);
    });
    if (!raw.first_name && !raw.last_name) return;

    dataRowNumber += 1;
    rows.push({
      row_number: dataRowNumber,
      first_name: raw.first_name ?? '',
      last_name: raw.last_name ?? '',
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      dob: raw.dob ?? null,
      gender: raw.gender ?? null,
      address: raw.address ?? null,
      blood_group: raw.blood_group ?? null,
      emergency_contact_name: raw.emergency_contact_name ?? null,
      emergency_contact_phone: raw.emergency_contact_phone ?? null,
      parent1: buildParent(raw, 'parent1'),
      parent2: buildParent(raw, 'parent2'),
    });
  });

  return rows;
}
