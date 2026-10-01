import pool from '../db/client';
import { logger } from '../config/logger';
import { isSmsEnabled, sendTermiiSms } from '../services/termiiService';

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

describe('isSmsEnabled', () => {
  it('is on when TERMII_API_KEY holds a value', () => {
    expect(isSmsEnabled()).toBe(true);
  });

  it('is off when TERMII_API_KEY is not set', () => {
    delete process.env.TERMII_API_KEY;
    expect(isSmsEnabled()).toBe(false);
  });

  it('is off when TERMII_API_KEY is blank — an emptied variable is not a key', () => {
    process.env.TERMII_API_KEY = '   ';
    expect(isSmsEnabled()).toBe(false);
  });
});

describe('sendTermiiSms', () => {
  it("answers 'disabled' — not a failure — without a query, a call or an error log when SMS is off", async () => {
    const errorSpy = jest.spyOn(logger, 'error');
    for (const key of [undefined, '']) {
      if (key === undefined) delete process.env.TERMII_API_KEY; else process.env.TERMII_API_KEY = key;
      expect(await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello')).toBe('disabled');
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("uses the school's sms_sender_name from school_settings when set", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: { sms_sender_name: 'MySchool' } }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    const result = await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    expect(result).toBe('sent');
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

  it("answers 'failed' and logs the status, not the number, when Termii rejects the message", async () => {
    const errorSpy = jest.spyOn(logger, 'error');
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: {} }] });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    expect(result).toBe('failed');
    expect(errorSpy).toHaveBeenCalledWith('termii_sms_failed', { schoolId: SCHOOL_ID, status: 401 });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('2348011111111');
    errorSpy.mockRestore();
  });

  it("answers 'failed' and does not throw when fetch rejects", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ notification_config: {} }] });
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network error'));

    const result = await sendTermiiSms(SCHOOL_ID, '+2348011111111', 'hello');

    expect(result).toBe('failed');
  });
});
