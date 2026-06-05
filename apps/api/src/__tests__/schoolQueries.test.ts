import pool from '../db/client';
import {
  insertSchool,
  insertSchoolSettings,
  findSchoolById,
  updateIdentityConfig,
  updateAcademicConfig,
  checkPublishedResultsExist,
  checkSubmittedResultsExist,
} from '../db/queries/schools';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('insertSchool', () => {
  it('inserts with name and slug, returns row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'abc', name: 'Test School', slug: 'test-school', is_active: true, created_at: '', updated_at: '' }],
    });
    const school = await insertSchool('Test School', 'test-school');
    expect(school.slug).toBe('test-school');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO schools'),
      ['Test School', 'test-school']
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
      rows: [{ id: 'abc', name: 'Test', slug: 'test', is_active: true, created_at: '', updated_at: '', identity_config: {}, academic_config: {} }],
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
  it('merges patch into academic_config JSONB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateAcademicConfig('abc', { promotion_cutoff: 45 });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('academic_config = academic_config ||'),
      [JSON.stringify({ promotion_cutoff: 45 }), 'abc']
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
