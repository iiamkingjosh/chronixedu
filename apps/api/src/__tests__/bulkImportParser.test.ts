import ExcelJS from 'exceljs';
import { parseBulkImportFile, BulkImportParseError } from '../services/bulkImportParser';

async function makeXlsxBuffer(headers: string[], rows: (string | number | boolean)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  sheet.addRow(headers);
  rows.forEach(r => sheet.addRow(r));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function makeCsvBuffer(headers: string[], rows: string[][]): Buffer {
  const lines = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(','));
  return Buffer.from(lines.join('\n'), 'utf-8');
}

describe('parseBulkImportFile — .xlsx', () => {
  it('parses a well-formed row with a student and one parent', async () => {
    const buffer = await makeXlsxBuffer(
      ['First Name', 'Last Name', 'Email', 'Parent 1 First Name', 'Parent 1 Last Name', 'Parent 1 Email', 'Parent 1 Relationship'],
      [['Tunde', 'Okonkwo', 'tunde@example.com', 'Bisi', 'Okonkwo', 'bisi@example.com', 'Mother']]
    );

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_number: 1,
      first_name: 'Tunde',
      last_name: 'Okonkwo',
      email: 'tunde@example.com',
    });
    expect(rows[0].parent1).toMatchObject({
      first_name: 'Bisi',
      last_name: 'Okonkwo',
      email: 'bisi@example.com',
      relationship_type: 'Mother',
      is_primary_contact: false,
    });
    expect(rows[0].parent2).toBeNull();
  });

  it('leaves optional student fields null when the columns are absent', async () => {
    const buffer = await makeXlsxBuffer(['First Name', 'Last Name'], [['Ada', 'Bello']]);

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows[0]).toMatchObject({ first_name: 'Ada', last_name: 'Bello', email: null, dob: null, parent1: null, parent2: null });
  });

  it('matches headers case-insensitively', async () => {
    const buffer = await makeXlsxBuffer(['first name', 'LAST NAME'], [['Chidi', 'Nwosu']]);

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows[0]).toMatchObject({ first_name: 'Chidi', last_name: 'Nwosu' });
  });

  it('assigns sequential row_number values, skipping fully blank trailing rows', async () => {
    const buffer = await makeXlsxBuffer(
      ['First Name', 'Last Name'],
      [['Ada', 'Bello'], ['', ''], ['Chidi', 'Nwosu']]
    );

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows.map(r => r.row_number)).toEqual([1, 2]);
    expect(rows[1].first_name).toBe('Chidi');
  });

  it('throws BulkImportParseError when required headers are missing entirely', async () => {
    const buffer = await makeXlsxBuffer(['Email'], [['x@example.com']]);

    await expect(parseBulkImportFile(buffer, 'students.xlsx')).rejects.toThrow(BulkImportParseError);
  });

  it('builds Parent 2 independently of Parent 1', async () => {
    const buffer = await makeXlsxBuffer(
      ['First Name', 'Last Name', 'Parent 2 First Name', 'Parent 2 Last Name', 'Parent 2 Email', 'Parent 2 Relationship', 'Parent 2 Primary Contact (Yes/No)'],
      [['Ada', 'Bello', 'Femi', 'Bello', 'femi@example.com', 'Father', 'Yes']]
    );

    const rows = await parseBulkImportFile(buffer, 'students.xlsx');

    expect(rows[0].parent1).toBeNull();
    expect(rows[0].parent2).toMatchObject({ first_name: 'Femi', email: 'femi@example.com', is_primary_contact: true });
  });
});

describe('parseBulkImportFile — .csv', () => {
  it('parses a well-formed CSV file', async () => {
    const buffer = makeCsvBuffer(['First Name', 'Last Name', 'Email'], [['Tunde', 'Okonkwo', 'tunde@example.com']]);

    const rows = await parseBulkImportFile(buffer, 'students.csv');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ first_name: 'Tunde', last_name: 'Okonkwo', email: 'tunde@example.com' });
  });
});
