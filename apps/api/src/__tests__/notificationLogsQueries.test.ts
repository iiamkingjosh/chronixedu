import pool from '../db/client';
import { insertNotificationLog, hasReachedSmsLimit } from '../db/queries/notificationLogs';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

const SCHOOL_ID = 'school-1';
const USER_ID = 'user-1';

describe('insertNotificationLog', () => {
  it('inserts a notification log row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await insertNotificationLog({
      school_id: SCHOOL_ID,
      user_id: USER_ID,
      channel: 'sms',
      type: 'behaviour_incident',
      status: 'sent',
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notification_logs'),
      [SCHOOL_ID, USER_ID, 'sms', 'behaviour_incident', 'sent', null]
    );
  });

  it('inserts a detail string when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await insertNotificationLog({
      school_id: SCHOOL_ID,
      user_id: USER_ID,
      channel: 'sms',
      type: 'behaviour_incident',
      status: 'failed',
      detail: 'Termii API error',
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notification_logs'),
      [SCHOOL_ID, USER_ID, 'sms', 'behaviour_incident', 'failed', 'Termii API error']
    );
  });
});

describe('hasReachedSmsLimit', () => {
  it('returns false when the user has sent fewer than 3 SMS in the last day', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });

    const result = await hasReachedSmsLimit(USER_ID);

    expect(result).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("channel = 'sms'"),
      [USER_ID]
    );
  });

  it('returns true when the user has already sent 3 SMS in the last day', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });

    const result = await hasReachedSmsLimit(USER_ID);

    expect(result).toBe(true);
  });
});
