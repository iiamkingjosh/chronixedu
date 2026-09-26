import pool from '../db/client';
import { registerStudent, findUsersRolesByEmails } from '../db/queries/students';

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
  tempPassword: 'temp-pw',
};

const AUTH_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const createAuth = jest.fn(async () => AUTH_ID);

/** Phase 1 runs on pool.query OUTSIDE the transaction: prefix lookup, then sequence. */
function arrangePhase1(prefixRow: unknown, nextSeq: string) {
  (pool as unknown as { query: jest.Mock }).query
    .mockResolvedValueOnce({ rows: prefixRow === null ? [] : [prefixRow] })
    .mockResolvedValueOnce({ rows: [{ next_seq: nextSeq }] });
}

/** Phase 2 runs on the pooled client: BEGIN, insert user, insert student, COMMIT. */
function arrangeTransaction(client: { query: jest.Mock }, admissionNo: string) {
  client.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: AUTH_ID }] })
    .mockResolvedValueOnce({ rows: [studentRow(admissionNo)] })
    .mockResolvedValueOnce({ rows: [] });
}

describe('registerStudent — admission number generation', () => {
  it('uses the school-configured admission_prefix in PREFIX/YEAR/seq format', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);
    arrangePhase1({ admission_prefix: 'LGS' }, '1');
    arrangeTransaction(client, `LGS/${year}/0001`);

    const result = await registerStudent('school-1', STUDENT_INPUT, [], createAuth);

    expect(result.admission_no).toBe(`LGS/${year}/0001`);
    expect((pool as unknown as { query: jest.Mock }).query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("identity_config->>'admission_prefix'"),
      ['school-1']
    );
    expect((pool as unknown as { query: jest.Mock }).query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['school-1', `LGS/${year}/%`]
    );
  });

  it('creates a Supabase Auth identity and binds ITS id as users.id', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);
    arrangePhase1({ admission_prefix: 'LGS' }, '1');
    arrangeTransaction(client, `LGS/${year}/0001`);

    await registerStudent('school-1', STUDENT_INPUT, [], createAuth);

    expect(createAuth).toHaveBeenCalledWith(expect.objectContaining({ role: 'student' }));
    // Login resolves the local row by the id signInWithPassword returns, so a
    // generated id here produces an account that can never be logged into.
    const usersInsert = client.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    expect(usersInsert![1][0]).toBe(AUTH_ID);
  });

  it('defaults to "SCH" when admission_prefix is not set in identity_config', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    arrangePhase1({ admission_prefix: null }, '1');
    arrangeTransaction(client, `SCH/${year}/0001`);

    const result = await registerStudent('school-1', STUDENT_INPUT, [], createAuth);

    expect(result.admission_no).toBe(`SCH/${year}/0001`);
    expect((pool as unknown as { query: jest.Mock }).query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['school-1', `SCH/${year}/%`]
    );
  });

  it('defaults to "SCH" when no school_settings row exists', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    arrangePhase1(null, '1'); // identity_config lookup — no row
    arrangeTransaction(client, `SCH/${year}/0001`);

    const result = await registerStudent('school-1', STUDENT_INPUT, [], createAuth);

    expect(result.admission_no).toBe(`SCH/${year}/0001`);
  });

  it('generates a students.internal email with slashes replaced by hyphens when no email is provided', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    arrangePhase1({ admission_prefix: 'LGS' }, '1');
    arrangeTransaction(client, `LGS/${year}/0001`);

    const result = await registerStudent('school-1', STUDENT_INPUT, [], createAuth);

    expect(result.student.email).toBe(`lgs-${year}-0001@students.internal`);
    expect(result.student.email).not.toContain('/');
  });

  it('pads the sequence number to 4 digits and increments from the existing max', async () => {
    const year = new Date().getFullYear();
    const client = makeMockClient();
    mockConnect.mockResolvedValueOnce(client);

    arrangePhase1({ admission_prefix: 'LGS' }, '42');
    arrangeTransaction(client, `LGS/${year}/0042`);

    const result = await registerStudent('school-1', STUDENT_INPUT, [], createAuth);

    expect(result.admission_no).toBe(`LGS/${year}/0042`);
  });
});

describe('findUsersRolesByEmails', () => {
  it('returns an empty map without querying when given no emails', async () => {
    const result = await findUsersRolesByEmails([]);
    expect(result).toEqual(new Map());
    expect((pool as unknown as { query: jest.Mock }).query).not.toHaveBeenCalled();
  });

  it('returns a lowercase-email-to-role map from the query results', async () => {
    (pool as unknown as { query: jest.Mock }).query.mockResolvedValueOnce({
      rows: [{ email: 'Taken@Example.com', role: 'teacher' }],
    });

    const result = await findUsersRolesByEmails(['taken@example.com', 'free@example.com']);

    expect(result.get('taken@example.com')).toBe('teacher');
    expect(result.has('free@example.com')).toBe(false);
  });
});
