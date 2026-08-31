import pool from '../db/client';
import { findStudentsByAdmissionNumbers } from '../db/queries/students';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('findStudentsByAdmissionNumbers', () => {
  it('returns an empty map without querying when given no admission numbers', async () => {
    const result = await findStudentsByAdmissionNumbers('school-1', []);
    expect(result).toEqual(new Map());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns an admission_no-to-student map, scoped to active students in the school', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ admission_no: 'SCH/2024/0001', id: 'student-1', first_name: 'Ada', last_name: 'Obi' }],
    });

    const result = await findStudentsByAdmissionNumbers('school-1', ['SCH/2024/0001']);

    expect(result.get('SCH/2024/0001')).toEqual({ id: 'student-1', first_name: 'Ada', last_name: 'Obi' });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('u.is_active = TRUE'),
      ['school-1', ['SCH/2024/0001']]
    );
  });
});
