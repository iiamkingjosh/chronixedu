import * as analyticsQueries from '../db/queries/analytics';
import * as feesQueries from '../db/queries/fees';
import * as cron from 'node-cron';
import {
  generateSnapshot,
  runNightlyAnalyticsSnapshot,
  startAnalyticsCron,
  stopAnalyticsCron,
} from '../services/analyticsService';

jest.mock('../db/queries/analytics');
jest.mock('../db/queries/fees');
jest.mock('node-cron');

const mockAnalytics = analyticsQueries as jest.Mocked<typeof analyticsQueries>;
const mockFees = feesQueries as jest.Mocked<typeof feesQueries>;
const mockCron = cron as jest.Mocked<typeof cron>;

const EMPTY_OVERALL = { total_students: 0, students_with_scores: 0, school_average: null, pass_rate: null };
const EMPTY_ATTENDANCE = { total: 0, present: 0, absent: 0, late: 0, excused: 0, percentage: 0 };
const EMPTY_FEES = { total_expected: 0, total_collected: 0, total_outstanding: 0, counts: { unpaid: 0, partial: 0, paid: 0 } };

beforeEach(() => jest.clearAllMocks());

describe('generateSnapshot', () => {
  it('computes all four sections and persists a snapshot', async () => {
    const overall = { total_students: 50, students_with_scores: 48, school_average: 67.5, pass_rate: 80 };
    const subjects = [{ subject_id: 's1', subject_name: 'Maths', average: 72.3, pass_rate: 90, students_count: 20 }];
    const attendance = { total: 100, present: 80, absent: 10, late: 5, excused: 5, percentage: 85 };
    const fees = { total_expected: 100000, total_collected: 75000, total_outstanding: 25000, counts: { unpaid: 2, partial: 3, paid: 10 } };
    const snapshot = {
      id: 'snap-1', school_id: 'school-1', term_id: 'term-1', snapshot_date: '2026-06-11',
      overall_performance: overall, subject_performance: subjects, attendance_summary: attendance, fee_collection: fees,
      created_at: '2026-06-11T02:00:00.000Z',
    };

    mockAnalytics.computeOverallPerformance.mockResolvedValueOnce(overall);
    mockAnalytics.computeSubjectPerformance.mockResolvedValueOnce(subjects);
    mockAnalytics.computeAttendanceSummary.mockResolvedValueOnce(attendance);
    mockFees.getCollectionSummary.mockResolvedValueOnce(fees);
    mockAnalytics.upsertSnapshot.mockResolvedValueOnce(snapshot);

    const result = await generateSnapshot('school-1', 'term-1', '2026-06-11');

    expect(result).toEqual(snapshot);
    expect(mockAnalytics.computeOverallPerformance).toHaveBeenCalledWith('school-1', 'term-1');
    expect(mockAnalytics.computeSubjectPerformance).toHaveBeenCalledWith('school-1', 'term-1');
    expect(mockAnalytics.computeAttendanceSummary).toHaveBeenCalledWith('school-1', 'term-1');
    expect(mockFees.getCollectionSummary).toHaveBeenCalledWith('school-1', 'term-1');
    expect(mockAnalytics.upsertSnapshot).toHaveBeenCalledWith('school-1', 'term-1', '2026-06-11', {
      overall_performance: overall,
      subject_performance: subjects,
      attendance_summary: attendance,
      fee_collection: fees,
    });
  });

  it('defaults the snapshot date to today (YYYY-MM-DD) when not provided', async () => {
    mockAnalytics.computeOverallPerformance.mockResolvedValueOnce(EMPTY_OVERALL);
    mockAnalytics.computeSubjectPerformance.mockResolvedValueOnce([]);
    mockAnalytics.computeAttendanceSummary.mockResolvedValueOnce(EMPTY_ATTENDANCE);
    mockFees.getCollectionSummary.mockResolvedValueOnce(EMPTY_FEES);
    mockAnalytics.upsertSnapshot.mockResolvedValueOnce({} as never);

    await generateSnapshot('school-1', 'term-1');

    const dateArg = mockAnalytics.upsertSnapshot.mock.calls[0][2];
    expect(dateArg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('runNightlyAnalyticsSnapshot', () => {
  it('generates a snapshot for every school with a current term', async () => {
    mockAnalytics.listSchoolsWithCurrentTerm.mockResolvedValueOnce([
      { school_id: 'school-1', term_id: 'term-1' },
      { school_id: 'school-2', term_id: 'term-2' },
    ]);
    mockAnalytics.computeOverallPerformance.mockResolvedValue(EMPTY_OVERALL);
    mockAnalytics.computeSubjectPerformance.mockResolvedValue([]);
    mockAnalytics.computeAttendanceSummary.mockResolvedValue(EMPTY_ATTENDANCE);
    mockFees.getCollectionSummary.mockResolvedValue(EMPTY_FEES);
    mockAnalytics.upsertSnapshot.mockResolvedValue({} as never);

    await runNightlyAnalyticsSnapshot();

    expect(mockAnalytics.upsertSnapshot).toHaveBeenCalledTimes(2);
    expect(mockAnalytics.upsertSnapshot.mock.calls[0][0]).toBe('school-1');
    expect(mockAnalytics.upsertSnapshot.mock.calls[1][0]).toBe('school-2');
  });

  it('continues to the next school if one fails', async () => {
    mockAnalytics.listSchoolsWithCurrentTerm.mockResolvedValueOnce([
      { school_id: 'school-1', term_id: 'term-1' },
      { school_id: 'school-2', term_id: 'term-2' },
    ]);
    mockAnalytics.computeOverallPerformance
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValueOnce(EMPTY_OVERALL);
    mockAnalytics.computeSubjectPerformance.mockResolvedValue([]);
    mockAnalytics.computeAttendanceSummary.mockResolvedValue(EMPTY_ATTENDANCE);
    mockFees.getCollectionSummary.mockResolvedValue(EMPTY_FEES);
    mockAnalytics.upsertSnapshot.mockResolvedValue({} as never);

    await expect(runNightlyAnalyticsSnapshot()).resolves.toBeUndefined();

    expect(mockAnalytics.upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(mockAnalytics.upsertSnapshot.mock.calls[0][0]).toBe('school-2');
  });
});

describe('startAnalyticsCron / stopAnalyticsCron', () => {
  afterEach(() => stopAnalyticsCron());

  it('schedules the nightly snapshot job for 02:00', () => {
    const stop = jest.fn();
    mockCron.schedule.mockReturnValue({ stop } as never);

    startAnalyticsCron();

    expect(mockCron.schedule).toHaveBeenCalledWith('0 2 * * *', expect.any(Function));
  });

  it('does not schedule a second job if already running', () => {
    const stop = jest.fn();
    mockCron.schedule.mockReturnValue({ stop } as never);

    startAnalyticsCron();
    startAnalyticsCron();

    expect(mockCron.schedule).toHaveBeenCalledTimes(1);
  });

  it('stops the scheduled task', () => {
    const stop = jest.fn();
    mockCron.schedule.mockReturnValue({ stop } as never);

    startAnalyticsCron();
    stopAnalyticsCron();

    expect(stop).toHaveBeenCalled();
  });
});
