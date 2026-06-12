import * as cron from 'node-cron';
import * as analyticsQueries from '../db/queries/analytics';
import * as feesQueries from '../db/queries/fees';
import * as parentQueries from '../db/queries/parents';
import { createNotification } from '../db/queries/notifications';
import { insertNotificationLog, hasReachedSmsLimit } from '../db/queries/notificationLogs';
import { sendEmail } from '../services/emailService';
import { sendTermiiSms } from '../services/termiiService';
import {
  sendFeeRemindersForSchool,
  runFeeReminders,
  startFeeReminderCron,
  stopFeeReminderCron,
} from '../services/feeReminderService';

jest.mock('node-cron');
jest.mock('../db/queries/analytics');
jest.mock('../db/queries/fees');
jest.mock('../db/queries/parents');
jest.mock('../db/queries/notifications');
jest.mock('../db/queries/notificationLogs');
jest.mock('../services/emailService');
jest.mock('../services/termiiService');

const mockCron = cron as jest.Mocked<typeof cron>;
const mockAnalytics = analyticsQueries as jest.Mocked<typeof analyticsQueries>;
const mockFees = feesQueries as jest.Mocked<typeof feesQueries>;
const mockParents = parentQueries as jest.Mocked<typeof parentQueries>;
const mockCreateNotification = createNotification as jest.Mock;
const mockInsertLog = insertNotificationLog as jest.Mock;
const mockHasReachedLimit = hasReachedSmsLimit as jest.Mock;
const mockSendEmail = sendEmail as jest.Mock;
const mockSendTermiiSms = sendTermiiSms as jest.Mock;

const SCHOOL_ID = 'school-1';
const TERM_ID = 'term-1';
const STUDENT_ID = 'student-1';
const PARENT_ID = 'parent-1';

const OUTSTANDING_ROW = {
  student_id: STUDENT_ID,
  first_name: 'Ada',
  last_name: 'Obi',
  admission_no: 'ADM001',
  class_name: 'JSS 1',
  total_amount: 50000,
  amount_paid: 20000,
  balance: 30000,
  status: 'partial' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateNotification.mockResolvedValue(undefined);
  mockInsertLog.mockResolvedValue(undefined);
  mockHasReachedLimit.mockResolvedValue(false);
  mockSendEmail.mockResolvedValue(undefined);
  mockSendTermiiSms.mockResolvedValue(true);
});

describe('sendFeeRemindersForSchool', () => {
  it('sends an in-app notification, email and SMS to each linked parent of an outstanding-balance student', async () => {
    mockFees.getOutstandingBalances.mockResolvedValueOnce([OUTSTANDING_ROW as never]);
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: PARENT_ID, email: 'parent@test.com', phone: '+2348011111111' },
    ]);

    const count = await sendFeeRemindersForSchool(SCHOOL_ID, TERM_ID);

    expect(mockFees.getOutstandingBalances).toHaveBeenCalledWith(SCHOOL_ID, TERM_ID);
    expect(mockParents.getParentsForStudent).toHaveBeenCalledWith(STUDENT_ID);

    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      user_id: PARENT_ID,
      type: 'fee_reminder',
    }));

    expect(mockSendEmail).toHaveBeenCalledWith(
      'parent@test.com',
      expect.any(String),
      expect.stringContaining('Ada Obi')
    );

    expect(mockHasReachedLimit).toHaveBeenCalledWith(PARENT_ID);
    expect(mockSendTermiiSms).toHaveBeenCalledWith(SCHOOL_ID, '+2348011111111', expect.any(String));
    expect(mockInsertLog).toHaveBeenCalledWith({
      school_id: SCHOOL_ID,
      user_id: PARENT_ID,
      channel: 'sms',
      type: 'fee_reminder',
      status: 'sent',
    });

    expect(count).toBe(1);
  });

  it('skips SMS but still sends in-app and email when the parent has no phone number', async () => {
    mockFees.getOutstandingBalances.mockResolvedValueOnce([OUTSTANDING_ROW as never]);
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: PARENT_ID, email: 'parent@test.com', phone: null },
    ]);

    await sendFeeRemindersForSchool(SCHOOL_ID, TERM_ID);

    expect(mockCreateNotification).toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalled();
    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).not.toHaveBeenCalled();
  });

  it('logs "throttled" instead of sending SMS once the parent has reached their daily SMS limit', async () => {
    mockFees.getOutstandingBalances.mockResolvedValueOnce([OUTSTANDING_ROW as never]);
    mockParents.getParentsForStudent.mockResolvedValueOnce([
      { parent_id: PARENT_ID, email: 'parent@test.com', phone: '+2348011111111' },
    ]);
    mockHasReachedLimit.mockResolvedValue(true);

    await sendFeeRemindersForSchool(SCHOOL_ID, TERM_ID);

    expect(mockSendTermiiSms).not.toHaveBeenCalled();
    expect(mockInsertLog).toHaveBeenCalledWith({
      school_id: SCHOOL_ID,
      user_id: PARENT_ID,
      channel: 'sms',
      type: 'fee_reminder',
      status: 'throttled',
    });
  });

  it('returns 0 and sends nothing when there are no outstanding balances', async () => {
    mockFees.getOutstandingBalances.mockResolvedValueOnce([]);

    const count = await sendFeeRemindersForSchool(SCHOOL_ID, TERM_ID);

    expect(count).toBe(0);
    expect(mockParents.getParentsForStudent).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('runFeeReminders', () => {
  it('runs reminders for every school with a current term', async () => {
    mockAnalytics.listSchoolsWithCurrentTerm.mockResolvedValueOnce([
      { school_id: 'school-1', term_id: 'term-1' },
      { school_id: 'school-2', term_id: 'term-2' },
    ]);
    mockFees.getOutstandingBalances.mockResolvedValue([]);

    await runFeeReminders();

    expect(mockFees.getOutstandingBalances).toHaveBeenCalledWith('school-1', 'term-1');
    expect(mockFees.getOutstandingBalances).toHaveBeenCalledWith('school-2', 'term-2');
  });

  it('continues to the next school if one fails', async () => {
    mockAnalytics.listSchoolsWithCurrentTerm.mockResolvedValueOnce([
      { school_id: 'school-1', term_id: 'term-1' },
      { school_id: 'school-2', term_id: 'term-2' },
    ]);
    mockFees.getOutstandingBalances
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValueOnce([]);

    await expect(runFeeReminders()).resolves.toBeUndefined();

    expect(mockFees.getOutstandingBalances).toHaveBeenCalledTimes(2);
  });
});

describe('startFeeReminderCron / stopFeeReminderCron', () => {
  afterEach(() => stopFeeReminderCron());

  it('schedules the reminder job for Mondays at 08:00', () => {
    const stop = jest.fn();
    mockCron.schedule.mockReturnValue({ stop } as never);

    startFeeReminderCron();

    expect(mockCron.schedule).toHaveBeenCalledWith('0 8 * * 1', expect.any(Function));
  });

  it('does not schedule a second job if already running', () => {
    const stop = jest.fn();
    mockCron.schedule.mockReturnValue({ stop } as never);

    startFeeReminderCron();
    startFeeReminderCron();

    expect(mockCron.schedule).toHaveBeenCalledTimes(1);
  });

  it('stops the scheduled task', () => {
    const stop = jest.fn();
    mockCron.schedule.mockReturnValue({ stop } as never);

    startFeeReminderCron();
    stopFeeReminderCron();

    expect(stop).toHaveBeenCalled();
  });
});
