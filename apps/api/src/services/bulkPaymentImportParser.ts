import ExcelJS from 'exceljs';
import { Readable } from 'stream';

export interface ParsedPaymentRow {
  row_number: number;
  admission_no: string;
  amount: string;
  method: string;
  payment_date: string | null;
  reference: string | null;
}

export class BulkPaymentImportParseError extends Error {}

const REQUIRED_HEADERS = ['admission number', 'amount', 'method'];

const COLUMN_MAP: Record<string, string> = {
  'admission number': 'admission_no',
  'amount': 'amount',
  'method': 'method',
  'payment date': 'payment_date',
  'reference': 'reference',
};

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

async function worksheetFromBuffer(buffer: Buffer, filename: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'csv') {
    return workbook.csv.read(Readable.from(buffer));
  }
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new BulkPaymentImportParseError('The file has no worksheet.');
  return sheet;
}

export async function parseBulkPaymentImportFile(buffer: Buffer, filename: string): Promise<ParsedPaymentRow[]> {
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
    throw new BulkPaymentImportParseError(`The file is missing required column(s): ${missing.map(h => COLUMN_MAP[h]).join(', ')}`);
  }

  const rows: ParsedPaymentRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string | null> = {};
    columnIndexToField.forEach((field, colNumber) => {
      raw[field] = cellText(row.getCell(colNumber).value);
    });
    const hasAnyContent = Object.values(raw).some(v => v !== null);
    if (!hasAnyContent) return;

    rows.push({
      row_number: rowNumber,
      admission_no: raw.admission_no ?? '',
      amount: raw.amount ?? '',
      method: raw.method ? raw.method.toLowerCase() : '',
      payment_date: raw.payment_date ?? null,
      reference: raw.reference ?? null,
    });
  });

  return rows;
}
