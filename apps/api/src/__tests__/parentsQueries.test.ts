import pool from '../db/client';
import { getParentsForStudent } from '../db/queries/parents';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

const STUDENT_ID = 'student-1';

describe('getParentsForStudent', () => {
  it('returns parent id, email and phone for all parents linked to the student', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { parent_id: 'parent-1', email: 'mum@example.com', phone: '+2348000000001' },
        { parent_id: 'parent-2', email: 'dad@example.com', phone: null },
      ],
    });

    const result = await getParentsForStudent(STUDENT_ID);

    expect(result).toEqual([
      { parent_id: 'parent-1', email: 'mum@example.com', phone: '+2348000000001' },
      { parent_id: 'parent-2', email: 'dad@example.com', phone: null },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM parent_students'),
      [STUDENT_ID]
    );
  });
});
