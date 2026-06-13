import pool from '../db/client';
import { registerStudent } from '../db/queries/students';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockConnect = (pool as unknown as { connect: jest.Mock }).connect;

beforeEach(() => jest.clearAllMocks());

function makeMockClient() {
  return { query: jest.fn(), release: jest.fn() };
}

function studentRow(admissionNo: string) {
  return {
    id: 'student-1',
    school_id: 'school-1',
    user_id: 'user-1',
    admission_no: admissionNo,
    dob: null,
    gender: null,
    address: null,
    photo_url: null,
    blood_group: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
  };
}

const STUDENT_INPUT = {
  first_name: 'Tunde',
  last_name: 'Okonkwo',
  passwordHash: 'hashed-pw',
};

describe('registerStudent — admission number generation', () => {
  it('uses the school-configured admission_prefix in PREFIX/YEAR/seq format', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ admission_prefix: 'LGS' }] }) // identity_config lookup
      .mockResolvedValueOnce({ rows: [{ next_seq: '1' }] }) // sequence lookup
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // INSERT INTO users
      .mockResolvedValueOnce({ rows: [studentRow(`LGS/${year}/0001`)] }) // INSERT INTO students
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await registerStudent('school-1', STUDENT_INPUT, []);

    expect(result.admission_no).toBe(`LGS/${year}/0001`);

    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("identity_config->>'admission_prefix'"),
      ['school-1']
    );

    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      ['school-1', `LGS/${year}/%`]
    );
  });

  it('defaults to "SCH" when admission_prefix is not set in identity_config', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ admission_prefix: null }] }) // identity_config lookup
      .mockResolvedValueOnce({ rows: [{ next_seq: '1' }] }) // sequence lookup
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // INSERT INTO users
      .mockResolvedValueOnce({ rows: [studentRow(`SCH/${year}/0001`)] }) // INSERT INTO students
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await registerStudent('school-1', STUDENT_INPUT, []);

    expect(result.admission_no).toBe(`SCH/${year}/0001`);
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      ['school-1', `SCH/${year}/%`]
    );
  });

  it('defaults to "SCH" when no school_settings row exists', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // identity_config lookup — no row
      .mockResolvedValueOnce({ rows: [{ next_seq: '1' }] }) // sequence lookup
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // INSERT INTO users
      .mockResolvedValueOnce({ rows: [studentRow(`SCH/${year}/0001`)] }) // INSERT INTO students
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await registerStudent('school-1', STUDENT_INPUT, []);

    expect(result.admission_no).toBe(`SCH/${year}/0001`);
  });

  it('generates a students.internal email with slashes replaced by hyphens when no email is provided', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ admission_prefix: 'LGS' }] }) // identity_config lookup
      .mockResolvedValueOnce({ rows: [{ next_seq: '1' }] }) // sequence lookup
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // INSERT INTO users
      .mockResolvedValueOnce({ rows: [studentRow(`LGS/${year}/0001`)] }) // INSERT INTO students
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await registerStudent('school-1', STUDENT_INPUT, []);

    expect(result.student.email).toBe(`lgs-${year}-0001@students.internal`);
    expect(result.student.email).not.toContain('/');
  });

  it('pads the sequence number to 4 digits and increments from the existing max', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ admission_prefix: 'LGS' }] }) // identity_config lookup
      .mockResolvedValueOnce({ rows: [{ next_seq: '42' }] }) // sequence lookup
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] }) // INSERT INTO users
      .mockResolvedValueOnce({ rows: [studentRow(`LGS/${year}/0042`)] }) // INSERT INTO students
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const result = await registerStudent('school-1', STUDENT_INPUT, []);

    expect(result.admission_no).toBe(`LGS/${year}/0042`);
  });
});
