import pool from '../db/client';
import { createNotification } from '../db/queries/notifications';
import { sendEmail } from '../services/emailService';
import { sendTermiiSms } from '../services/termiiService';
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
  mockSendTermiiSms.mockResolvedValue(true);
});

function mockQueueAndParents(parentRows: Array<{ parent_id: string; email: string; phone: string | null }>) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM audit_logs') && sql.includes('SELECT id')) {
      return Promise.resolve({ rows: [AUDIT_ROW] });
    }
    if (sql.includes('FROM parent_students')) {
      return Promise.resolve({ rows: parentRows });
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
    mockSendTermiiSms.mockResolvedValue(false);

    await processNotificationQueue();

    expect(mockInsertLog).toHaveBeenCalledWith({
      school_id: SCHOOL_ID,
      user_id: PARENT_ID,
      channel: 'sms',
      type: 'behaviour_incident',
      status: 'failed',
    });
  });

  it('does not attempt SMS or log anything when the parent has no phone number', async () => {
    mockQueueAndParents([{ parent_id: PARENT_ID, email: 'p@test.com', phone: null }]);

    await processNotificationQueue();

    expect(mockHasReachedLimit).not.toHaveBeenCalled();
    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });
});
