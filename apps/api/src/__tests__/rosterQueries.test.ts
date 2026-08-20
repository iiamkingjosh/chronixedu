import pool from '../db/client';
import { findTeachersByEmails, listClassNamesAndIds, listSubjectCodesAndIds } from '../db/queries/roster';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('findTeachersByEmails', () => {
  it('returns an empty map without querying when given no emails', async () => {
    const result = await findTeachersByEmails('school-1', []);
    expect(result).toEqual(new Map());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns a lowercase-email-to-id map, scoped to teacher role', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'teacher-1', email: 'Chidi@Example.com' }],
    });

    const result = await findTeachersByEmails('school-1', ['chidi@example.com']);

    expect(result.get('chidi@example.com')).toEqual({ id: 'teacher-1' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("role = 'teacher'"),
      ['school-1', ['chidi@example.com']]
    );
  });
});

describe('listClassNamesAndIds', () => {
  it('returns all classes for the school as id/name pairs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'class-1', name: 'JSS 1A' }] });
    const result = await listClassNamesAndIds('school-1');
    expect(result).toEqual([{ id: 'class-1', name: 'JSS 1A' }]);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['school-1']);
  });
});

describe('listSubjectCodesAndIds', () => {
  it('returns all subjects for the school as id/code pairs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'subject-1', code: 'MTH' }] });
    const result = await listSubjectCodesAndIds('school-1');
    expect(result).toEqual([{ id: 'subject-1', code: 'MTH' }]);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['school-1']);
  });
});
