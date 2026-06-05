import pool from '../db/client';
import { logAudit } from '../db/queries/auditLog';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

const mockPool = pool as unknown as { query: jest.Mock };

describe('logAudit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a row with all required fields using correct column names', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await logAudit({
      schoolId: 'aaaaaaaa-0000-0000-0000-000000000001',
      userId: 'bbbbbbbb-0000-0000-0000-000000000001',
      actionType: 'SCORE_UPDATE',
      entity: 'scores',
      entityId: 'cccccccc-0000-0000-0000-000000000001',
      oldValue: { score: 80 },
      newValue: { score: 90 },
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('action_type'),
      [
        'aaaaaaaa-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000001',
        'SCORE_UPDATE',
        'scores',
        'cccccccc-0000-0000-0000-000000000001',
        { score: 80 },
        { score: 90 },
      ]
    );
  });

  it('passes null for optional fields when undefined', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await logAudit({
      schoolId: 'aaaaaaaa-0000-0000-0000-000000000001',
      userId: 'bbbbbbbb-0000-0000-0000-000000000001',
      actionType: 'IDENTITY_UPDATE',
      entity: 'school_settings',
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining([null, null, null])
    );
  });
});
