import pool from '../db/client';
import { publishReportCards, upsertReportCard } from '../db/queries/reportCards';

jest.mock('../db/client', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

beforeEach(() => jest.clearAllMocks());

describe('publishReportCards', () => {
  it('issues an UPDATE that flips is_published = TRUE for the given school/term/students', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await publishReportCards('school-1', 'term-1', ['student-1', 'student-2']);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE report_cards/);
    expect(sql).toMatch(/is_published\s*=\s*TRUE/);
    expect(sql).toMatch(/WHERE school_id = \$1 AND term_id = \$2 AND student_id = ANY\(\$3/);
    expect(params).toEqual(['school-1', 'term-1', ['student-1', 'student-2']]);
  });

  it('does not query the database when the student list is empty', async () => {
    await publishReportCards('school-1', 'term-1', []);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('upsertReportCard', () => {
  it('inserts with is_published derived from the student\'s current result_status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rc-1' }] });

    const id = await upsertReportCard('student-1', 'term-1', 'school-1', 'https://example.com/1.pdf');

    expect(id).toBe('rc-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO report_cards/);
    // The insert must not unconditionally default is_published to FALSE — it must
    // derive it from whether this student's results are already published, so that
    // a report card generated *after* publish is born published (see reportCardService's
    // generate-report-cards flow, which allows generation for 'approved' OR 'published').
    expect(sql).toMatch(/result_status/);
    expect(sql).toMatch(/status\s*=\s*'published'/);
    // Regeneration (ON CONFLICT) must never touch is_published — that is
    // publishReportCards()'s job exclusively, so a re-generated PDF can't
    // silently unpublish (or publish) an existing report card.
    const conflictClause = sql.slice(sql.indexOf('ON CONFLICT'));
    expect(conflictClause).not.toMatch(/is_published/);
    expect(params).toEqual(['student-1', 'term-1', 'school-1', 'https://example.com/1.pdf']);
  });
});
