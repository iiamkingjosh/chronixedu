import ExcelJS from 'exceljs';

export interface CreatedPaymentRecord {
  row_number: number;
  admission_no: string;
  student_name: string;
  amount: number;
  method: string;
}

export interface FailedPaymentRecord {
  row_number: number;
  admission_no: string;
  amount: string;
  method: string;
  reason: string;
}

export async function generateBulkPaymentImportResultsFile(
  created: CreatedPaymentRecord[],
  failed: FailedPaymentRecord[]
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 90 }];
  summary.addRow(['Chronix Edu — Bulk Payment Import Results']);
  summary.addRow([`${created.length} payment(s) recorded, ${failed.length} row(s) failed.`]);

  const recordedSheet = workbook.addWorksheet('Payments Recorded');
  recordedSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Admission Number', key: 'admission_no', width: 20 },
    { header: 'Student Name', key: 'student_name', width: 24 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Method', key: 'method', width: 14 },
  ];
  created.forEach(c => recordedSheet.addRow(c));

  const failedSheet = workbook.addWorksheet('Payments Failed');
  failedSheet.columns = [
    { header: 'Row #', key: 'row_number', width: 8 },
    { header: 'Admission Number', key: 'admission_no', width: 20 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Method', key: 'method', width: 14 },
    { header: 'Reason', key: 'reason', width: 50 },
  ];
  failed.forEach(f => failedSheet.addRow(f));

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
