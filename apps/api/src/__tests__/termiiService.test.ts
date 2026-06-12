import pool from '../db/client';
import { isSmsConfigured, sendTermiiSms } from '../services/termiiService';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

const SCHOOL_ID = 'school-1';
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, TERMII_API_KEY: 'test-key', TERMII_SENDER_ID: 'ChronixEdu' };
  global.fetch = jest.fn();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('isSmsConfigured', () => {
  it('returns false when TERMII_API_KEY is not set', () => {
    delete process.env.TERMII_API_KEY;
    expect(isSmsConfigured()).toBe(false);
  });

  it('returns true when TERMII_API_KEY is set', () => {
    expect(isSmsConfigured()).toBe(true);
  });
});

describe('sendTermiiSms', () => {
  it('returns false immediately when Termii is not configured', async () => {
    delete process.env.TERMII_API_KEY;

    const result = await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("uses the school's sms_sender_name from school_settings when set", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: { sms_sender_name: 'MySchool' } }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    const result = await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM school_settings'), [SCHOOL_ID]);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ to: '+2348011111111', from: 'MySchool', sms: 'hello' });
  });

  it('falls back to TERMII_SENDER_ID when notification_config has no sms_sender_name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: {} }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ from: 'ChronixEdu' });
  });

  it('falls back to TERMII_SENDER_ID when notification_config is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: null }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ from: 'ChronixEdu' });
  });

  it('returns false when the Termii API responds with a non-ok status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: {} }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false });

    const result = await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    expect(result).toBe(false);
  });

  it('returns false and does not throw when fetch rejects', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: {} }] });
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network error'));

    const result = await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    expect(result).toBe(false);
  });
});
