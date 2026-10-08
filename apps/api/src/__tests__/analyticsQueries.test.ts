import pool from '../db/client';
import {
  computeOverallPerformance,
  computeSubjectPerformance,
  computeAttendanceSummary,
  upsertSnapshot,
  getLatestSnapshot,
  getPreviousSnapshot,
  listSchoolsWithCurrentTerm,
} from '../db/queries/analytics';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

const SCHOOL_ID = 'school-uuid-001';
const TERM_ID = 'term-uuid-001';

// The school's academic config, read first by both performance queries for its pass marks.
const settings = (academic_config: Record<string, unknown> | null) => ({ rows: academic_config === null ? [] : [{ academic_config }] });

describe('computeOverallPerformance', () => {
  it("combines student counts and subject-total aggregates, judged against the school's pass marks", async () => {
    mockQuery
      .mockResolvedValueOnce(settings({ promotion_cutoff: 45, level_overrides: { Senior: { promotion_cutoff: 50 }, Junior: { grading_scale: [] } } }))
      .mockResolvedValueOnce({ rows: [{ total_students: 50 }] })
      .mockResolvedValueOnce({
        rows: [{ school_average: '67.50', students_with_scores: 48, pass_count: 40, judged_count: 50 }],
      });

    const result = await computeOverallPerformance(SCHOOL_ID, TERM_ID);

    expect(result).toEqual({
      total_students: 50,
      students_with_scores: 48,
      school_average: 67.5,
      pass_rate: 80,
      pass_mark: 45,
    });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    // Only levels that set a pass mark go in the map; Junior set a scale only.
    expect(mockQuery.mock.calls[2][1]).toEqual([SCHOOL_ID, TERM_ID, JSON.stringify({ Senior: 50 }), 45]);
  });

  it('returns nulls when no scores exist for the term', async () => {
    mockQuery
      .mockResolvedValueOnce(settings({ promotion_cutoff: 45 }))
      .mockResolvedValueOnce({ rows: [{ total_students: 10 }] })
      .mockResolvedValueOnce({
        rows: [{ school_average: null, students_with_scores: 0, pass_count: 0, judged_count: 0 }],
      });

    const result = await computeOverallPerformance(SCHOOL_ID, TERM_ID);

    expect(result).toEqual({
      total_students: 10,
      students_with_scores: 0,
      school_average: null,
      pass_rate: null,
      pass_mark: 45,
    });
  });

  it('a school with no settings row has no pass mark, and passes none to the query', async () => {
    mockQuery
      .mockResolvedValueOnce(settings(null))
      .mockResolvedValueOnce({ rows: [{ total_students: 10 }] })
      .mockResolvedValueOnce({ rows: [{ school_average: '50.00', students_with_scores: 2, pass_count: 0, judged_count: 0 }] });

    const result = await computeOverallPerformance(SCHOOL_ID, TERM_ID);

    expect(result.pass_mark).toBeNull();
    expect(result.pass_rate).toBeNull();
    expect(mockQuery.mock.calls[2][1]).toEqual([SCHOOL_ID, TERM_ID, '{}', null]);
  });
});

describe('computeSubjectPerformance', () => {
  it('returns per-subject averages and pass rates', async () => {
    mockQuery
      .mockResolvedValueOnce(settings({ promotion_cutoff: 40 }))
      .mockResolvedValueOnce({
        rows: [
          { subject_id: 'subj-1', subject_name: 'Mathematics', average: '72.30', pass_count: 18, judged_count: 20, students_count: 20 },
          { subject_id: 'subj-2', subject_name: 'English', average: '58.00', pass_count: 12, judged_count: 20, students_count: 20 },
          // Nobody judged: no pass mark applies to any of its students.
          { subject_id: 'subj-3', subject_name: 'French', average: '61.00', pass_count: 0, judged_count: 0, students_count: 4 },
        ],
      });

    const result = await computeSubjectPerformance(SCHOOL_ID, TERM_ID);

    expect(result).toEqual([
      { subject_id: 'subj-1', subject_name: 'Mathematics', average: 72.3, pass_rate: 90, students_count: 20 },
      { subject_id: 'subj-2', subject_name: 'English', average: 58, pass_rate: 60, students_count: 20 },
      { subject_id: 'subj-3', subject_name: 'French', average: 61, pass_rate: null, students_count: 4 },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [SCHOOL_ID, TERM_ID, '{}', 40]);
  });

  it('returns an empty array when no subjects have scores', async () => {
    mockQuery.mockResolvedValueOnce(settings({})).mockResolvedValueOnce({ rows: [] });

    const result = await computeSubjectPerformance(SCHOOL_ID, TERM_ID);

    expect(result).toEqual([]);
  });
});

describe('computeAttendanceSummary', () => {
  it('computes totals and the present+late percentage', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ present: 80, absent: 10, late: 5, excused: 5, total: 100 }],
    });

    const result = await computeAttendanceSummary(SCHOOL_ID, TERM_ID);

    expect(result).toEqual({
      total: 100,
      present: 80,
      absent: 10,
      late: 5,
      excused: 5,
      percentage: 85,
    });
  });

  it('returns zeroes when there are no attendance records', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ present: 0, absent: 0, late: 0, excused: 0, total: 0 }],
    });

    const result = await computeAttendanceSummary(SCHOOL_ID, TERM_ID);

    expect(result).toEqual({
      total: 0,
      present: 0,
      absent: 0,
      late: 0,
      excused: 0,
      percentage: 0,
    });
  });
});

describe('upsertSnapshot', () => {
  const SNAPSHOT_DATA = {
    overall_performance: { total_students: 50, students_with_scores: 48, school_average: 67.5, pass_rate: 80, pass_mark: 40 },
    subject_performance: [{ subject_id: 'subj-1', subject_name: 'Mathematics', average: 72.3, pass_rate: 90, students_count: 20 }],
    attendance_summary: { total: 100, present: 80, absent: 10, late: 5, excused: 5, percentage: 85 },
    fee_collection: { total_expected: 100000, total_collected: 75000, total_outstanding: 25000, counts: { unpaid: 2, partial: 3, paid: 10 } },
  };

  it('inserts a snapshot row, upserting on (school, term, date)', async () => {
    const row = { id: 'snap-1', school_id: SCHOOL_ID, term_id: TERM_ID, snapshot_date: '2026-06-11', ...SNAPSHOT_DATA, created_at: '2026-06-11T02:00:00.000Z' };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await upsertSnapshot(SCHOOL_ID, TERM_ID, '2026-06-11', SNAPSHOT_DATA);

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (school_id, term_id, snapshot_date)'),
      [
        SCHOOL_ID,
        TERM_ID,
        '2026-06-11',
        JSON.stringify(SNAPSHOT_DATA.overall_performance),
        JSON.stringify(SNAPSHOT_DATA.subject_performance),
        JSON.stringify(SNAPSHOT_DATA.attendance_summary),
        JSON.stringify(SNAPSHOT_DATA.fee_collection),
      ]
    );
  });
});

describe('getLatestSnapshot', () => {
  it('returns the most recent snapshot for a school/term', async () => {
    const row = { id: 'snap-1', school_id: SCHOOL_ID, term_id: TERM_ID, snapshot_date: '2026-06-11' };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await getLatestSnapshot(SCHOOL_ID, TERM_ID);

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ORDER BY snapshot_date DESC'), [SCHOOL_ID, TERM_ID]);
  });

  it('returns null when no snapshot exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getLatestSnapshot(SCHOOL_ID, TERM_ID);

    expect(result).toBeNull();
  });
});

describe('getPreviousSnapshot', () => {
  it('returns the most recent snapshot before a given date', async () => {
    const row = { id: 'snap-0', school_id: SCHOOL_ID, term_id: TERM_ID, snapshot_date: '2026-06-10' };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await getPreviousSnapshot(SCHOOL_ID, TERM_ID, '2026-06-11');

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('snapshot_date < $3'), [SCHOOL_ID, TERM_ID, '2026-06-11']);
  });

  it('returns null when there is no earlier snapshot', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPreviousSnapshot(SCHOOL_ID, TERM_ID, '2026-06-11');

    expect(result).toBeNull();
  });
});

describe('listSchoolsWithCurrentTerm', () => {
  it('returns school/term pairs for every school with an active session and term', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { school_id: 'school-1', term_id: 'term-1' },
        { school_id: 'school-2', term_id: 'term-2' },
      ],
    });

    const result = await listSchoolsWithCurrentTerm();

    expect(result).toEqual([
      { school_id: 'school-1', term_id: 'term-1' },
      { school_id: 'school-2', term_id: 'term-2' },
    ]);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('is_current = TRUE'));
  });
});
