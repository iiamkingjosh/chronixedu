import pool from '../db/client';
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  updateReportConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
} from '../db/queries/schools';

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../db/client', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    // updateAcademicConfig runs its read-lock-write on one checked-out client.
    connect: jest.fn(async () => ({ query: mockClientQuery, release: mockRelease })),
  },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('insertSchool', () => {
  it('inserts with name, slug and the stated is_demo, returns row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'abc', name: 'Test School', slug: 'test-school', is_active: true, created_at: '', updated_at: '' }],
    });
    const school = await insertSchool('Test School', 'test-school', false);
    expect(school.slug).toBe('test-school');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schools'),
      ['Test School', 'test-school', false]
    );
  });
});

describe('insertSchoolSettings', () => {
  it('inserts and returns id + school_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1', school_id: 'abc' }] });
    const row = await insertSchoolSettings('abc', {}, { grading_scale: [] });
    expect(row.school_id).toBe('abc');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO school_settings'),
      expect.arrayContaining(['abc'])
    );
  });
});

describe('findSchoolById', () => {
  it('returns school with settings when found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'abc', name: 'Test', slug: 'test', is_active: true, created_at: '', updated_at: '', identity_config: {}, academic_config: {}, report_config: {} }],
    });
    const result = await findSchoolById('abc');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('abc');
  });

  it('returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findSchoolById('missing');
    expect(result).toBeNull();
  });

  it('selects report_config from school_settings', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findSchoolById('abc');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ss.report_config'),
      ['abc']
    );
  });
});

describe('updateIdentityConfig', () => {
  it('merges patch into identity_config JSONB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateIdentityConfig('abc', { name: 'New Name' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('identity_config = identity_config ||'),
      [JSON.stringify({ name: 'New Name' }), 'abc']
    );
  });
});

describe('updateAcademicConfig', () => {
  it('ensures the row, reads the prior value under a lock, merges, and returns the prior', async () => {
    // Shape only — the behaviour (a second save names the first's value; a concurrent
    // save waits) is proven against a real database in settingsAudit.db.test.ts.
    mockClientQuery.mockImplementation(async (sql: string) =>
      /FOR UPDATE/.test(sql) ? { rows: [{ cfg: { promotion_cutoff: 40, grading_scale: [] } }] } : { rows: [] });

    const prior = await updateAcademicConfig('abc', { promotion_cutoff: 45 });

    const sqls = mockClientQuery.mock.calls.map(c => String(c[0]));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain('ON CONFLICT (school_id) DO NOTHING');
    expect(sqls[2]).toContain('FOR UPDATE');
    expect(sqls[3]).toContain('academic_config = academic_config || $1::jsonb');
    expect(sqls[4]).toBe('COMMIT');
    // Only the patched key, with the value that was there — not the whole config.
    expect(prior).toEqual({ promotion_cutoff: 40 });
    expect(mockRelease).toHaveBeenCalled();
  });
});

describe('updateReportConfig', () => {
  it('merges patch into report_config JSONB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateReportConfig('abc', { template: 'modern', show_attendance: false });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('report_config = report_config ||'),
      [JSON.stringify({ template: 'modern', show_attendance: false }), 'abc']
    );
  });
});

describe('checkPublishedResultsExist', () => {
  it('returns false when query fails (table missing)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "result_status" does not exist'));
    expect(await checkPublishedResultsExist('abc')).toBe(false);
  });

  it('returns true when count > 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    expect(await checkPublishedResultsExist('abc')).toBe(true);
  });

  it('returns false when count is 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    expect(await checkPublishedResultsExist('abc')).toBe(false);
  });
});

describe('checkSubmittedResultsExist', () => {
  it('returns false when query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('error'));
    expect(await checkSubmittedResultsExist('abc')).toBe(false);
  });

  it('returns true when submitted rows exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    expect(await checkSubmittedResultsExist('abc')).toBe(true);
  });
});
