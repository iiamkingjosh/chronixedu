import pool from '../db/client';
import { createNotification } from '../db/queries/notifications';
import { sendEmail } from '../services/emailService';
import { sendTermiiSms, isSmsEnabled } from '../services/termiiService';
import { logger } from '../config/logger';
import { insertNotificationLog, hasReachedSmsLimit } from '../db/queries/notificationLogs';
import { processNotificationQueue } from '../services/notificationWorker';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('../db/queries/notifications');
jest.mock('../services/emailService');
jest.mock('../services/termiiService');
jest.mock('../db/queries/notificationLogs');

const mockQuery = (pool as unknown as { query: jest.Mock }).query;
const mockCreateNotification = createNotification as jest.Mock;
const mockSendEmail = sendEmail as jest.Mock;
const mockSendTermiiSms = sendTermiiSms as jest.Mock;
const mockIsSmsEnabled = isSmsEnabled as jest.Mock;
const mockInsertLog = insertNotificationLog as jest.Mock;
const mockHasReachedLimit = hasReachedSmsLimit as jest.Mock;

const SCHOOL_ID = 'school-1';
const PARENT_ID = 'parent-1';

const AUDIT_ROW = {
  id: 'audit-1',
  school_id: SCHOOL_ID,
  entity: 'behaviour_records',
  entity_id: 'record-1',
  new_value: {
    student_id: 'student-1',
    notification_type: 'behaviour_incident',
    severity: 'suspension',
    incident_type: 'Fighting',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateNotification.mockResolvedValue(undefined);
  mockSendEmail.mockResolvedValue(undefined);
  mockInsertLog.mockResolvedValue(undefined);
  mockHasReachedLimit.mockResolvedValue(false);
  mockSendTermiiSms.mockResolvedValue('sent');
  mockIsSmsEnabled.mockReturnValue(true);
});

function mockQueueAndParents(parentRows: Array<{ parent_id: string; email: string; phone: string | null }>) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM audit_logs') && sql.includes('SELECT id')) {
      return Promise.resolve({ rows: [AUDIT_ROW] });
    }
    if (sql.includes('FROM parent_students')) {
      return Promise.resolve({ rows: parentRows });
    }
    if (sql.includes('FROM schools')) {
      return Promise.resolve({ rows: [{ subscription_tier: 'trial', subscription_status: 'trial' }] });
    }
    if (sql.includes('UPDATE audit_logs')) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('processNotificationQueue — SMS delivery', () => {
  it('sends SMS via termiiService and logs a "sent" attempt when the parent has a phone and is not throttled', async () => {
    mockQueueAndParents([{ parent_id: PARENT_ID, email: 'p@test.com', phone: '+2348011111111' }]);

    await processNotificationQueue();

    expect(mockHasReachedLimit).toHaveBeenCalledWith(PARENT_ID);
    expect(mockSendTermiiSms).toHaveBeenCalledWith(SCHOOL_ID, '+2348011111111', expect.any(String));
    expect(mockInsertLog).toHaveBeenCalledWith({
      school_id: SCHOOL_ID,
      user_id: PARENT_ID,
      channel: 'sms',
      type: 'behaviour_incident',
      status: 'sent',
    });
  });

  it('skips sending and logs "throttled" when the parent has reached their daily SMS limit', async () => {
    mockQueueAndParents([{ parent_id: PARENT_ID, email: 'p@test.com', phone: '+2348011111111' }]);
    mockHasReachedLimit.mockResolvedValue(true);

    await processNotificationQueue();

    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).toHaveBeenCalledWith({
      school_id: SCHOOL_ID,
      user_id: PARENT_ID,
      channel: 'sms',
      type: 'behaviour_incident',
      status: 'throttled',
    });
  });

  it('logs a "failed" attempt when the Termii API call does not succeed', async () => {
    mockQueueAndParents([{ parent_id: PARENT_ID, email: 'p@test.com', phone: '+2348011111111' }]);
    mockSendTermiiSms.mockResolvedValue('failed');

    await processNotificationQueue();

    expect(mockInsertLog).toHaveBeenCalledWith({
      school_id: SCHOOL_ID,
      user_id: PARENT_ID,
      channel: 'sms',
      type: 'behaviour_incident',
      status: 'failed',
    });
  });

  it('with SMS switched off: in-app and email still go, Termii is not called, no SMS row, one sms_disabled line for the batch', async () => {
    // Two parents with phones, so "one line" is one per batch and not one per parent. The
    // first test in this block is the control: the same queue, SMS on, a text sent and logged.
    mockQueueAndParents([
      { parent_id: PARENT_ID, email: 'p@test.com', phone: '+2348011111111' },
      { parent_id: 'parent-2', email: 'p2@test.com', phone: '+2348022222222' },
    ]);
    mockIsSmsEnabled.mockReturnValue(false);
    const infoSpy: jest.SpyInstance = jest.spyOn(logger, 'info');
    const errorSpy = jest.spyOn(logger, 'error');

    await expect(processNotificationQueue()).resolves.toBeUndefined();

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockHasReachedLimit).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
    const lines = infoSpy.mock.calls.filter(([event]) => event === 'sms_disabled');
    expect(lines).toEqual([['sms_disabled', expect.objectContaining({ run: 'notification_worker', notifications: 1, sms_not_sent: 2 })]]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SET processed_at'), ['audit-1']);
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('with SMS switched off and nothing queued, says nothing (no line every 30s)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsSmsEnabled.mockReturnValue(false);
    const infoSpy: jest.SpyInstance = jest.spyOn(logger, 'info');

    await processNotificationQueue();

    expect(infoSpy.mock.calls.filter(([event]) => event === 'sms_disabled')).toHaveLength(0);
    infoSpy.mockRestore();
  });

  it('does not attempt SMS or log anything when the parent has no phone number', async () => {
    mockQueueAndParents([{ parent_id: PARENT_ID, email: 'p@test.com', phone: null }]);

    await processNotificationQueue();

    expect(mockHasReachedLimit).not.toHaveBeenCalled();
    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });

  it('skips SMS but still creates the notification and sends email when the school is read-only', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM audit_logs') && sql.includes('SELECT id')) {
        return Promise.resolve({ rows: [AUDIT_ROW] });
      }
      if (sql.includes('FROM parent_students')) {
        return Promise.resolve({ rows: [{ parent_id: PARENT_ID, email: 'p@test.com', phone: '+2348011111111' }] });
      }
      if (sql.includes('FROM schools')) {
        return Promise.resolve({ rows: [{ subscription_tier: 'trial', subscription_status: 'read_only' }] });
      }
      if (sql.includes('UPDATE audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await processNotificationQueue();

    expect(mockCreateNotification).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalled();
    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });
});
