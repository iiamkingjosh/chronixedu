import pool from '../client';
import { CollectionSummary } from './fees';

/**
 * The school's pass marks: the school-wide one, and each level's own where a level sets one
 * (`academic_config.level_overrides[level].promotion_cutoff`). Either may be unset. Analytics used a
 * constant 40 for every school until 8 Oct 2026, chosen or not (doctrine 8).
 */
export interface PassMarks {
  school: number | null;
  byLevel: Record<string, number>;
}

export async function fetchPassMarks(schoolId: string): Promise<PassMarks> {
  const { rows } = await pool.query<{ academic_config: Record<string, unknown> | null }>(
    `SELECT academic_config FROM school_settings WHERE school_id = $1`, [schoolId]);
  const config = rows[0]?.academic_config ?? {};
  const cutoff = config.promotion_cutoff;
  const byLevel: Record<string, number> = {};
  const overrides = (config.level_overrides ?? {}) as Record<string, { promotion_cutoff?: unknown }>;
  for (const [level, override] of Object.entries(overrides)) {
    if (typeof override?.promotion_cutoff === 'number') byLevel[level] = override.promotion_cutoff;
  }
  return { school: typeof cutoff === 'number' ? cutoff : null, byLevel };
}

// Each (student, subject) total for the term, with the pass mark that applies to the student: their
// class's level's, else the school's, else none (NULL: not judged). $3 is the level map, $4 the
// school-wide mark. The class is the student's this session; a student with two classes in one
// session (no unique constraint, CLAUDE.md) takes the latest.
const JUDGED_TOTALS = `
  WITH totals AS (
    SELECT sc.student_id, sc.subject_id,
      SUM(sc.score / NULLIF(ac.max_score, 0)::float * ac.weight_percent) AS subject_total
    FROM scores sc
    JOIN assessment_components ac ON ac.id = sc.component_id
    WHERE sc.school_id = $1 AND sc.term_id = $2
    GROUP BY sc.student_id, sc.subject_id
  ),
  levels AS (
    SELECT DISTINCT ON (stc.student_id) stc.student_id, c.level
    FROM student_classes stc
    JOIN classes c ON c.id = stc.class_id AND c.school_id = $1
    WHERE stc.session_id = (SELECT session_id FROM terms WHERE id = $2 AND school_id = $1)
    ORDER BY stc.student_id, stc.enrolled_at DESC
  ),
  judged AS (
    SELECT t.student_id, t.subject_id, t.subject_total,
           COALESCE(($3::jsonb ->> l.level)::numeric, $4::numeric) AS pass_mark
    FROM totals t LEFT JOIN levels l ON l.student_id = t.student_id
  )`;

export interface OverallPerformance {
  total_students: number;
  students_with_scores: number;
  school_average: number | null;
  /** Share of subject results at or above the pass mark that applies; null when none applies. */
  pass_rate: number | null;
  /** The school-wide pass mark, or null when the school has not set one. */
  pass_mark: number | null;
}

export interface SubjectPerformanceRow {
  subject_id: string;
  subject_name: string;
  average: number;
  pass_rate: number | null;
  students_count: number;
}

export interface AttendanceSummaryData {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  percentage: number;
}

export interface SnapshotData {
  overall_performance: OverallPerformance;
  subject_performance: SubjectPerformanceRow[];
  attendance_summary: AttendanceSummaryData;
  fee_collection: CollectionSummary;
}

export interface AnalyticsSnapshotRow extends SnapshotData {
  id: string;
  school_id: string;
  term_id: string;
  snapshot_date: string;
  created_at: string;
}

export interface SchoolTermPair {
  school_id: string;
  term_id: string;
}

export async function computeOverallPerformance(schoolId: string, termId: string): Promise<OverallPerformance> {
  const marks = await fetchPassMarks(schoolId);
  const [studentsResult, perfResult] = await Promise.all([
    pool.query<{ total_students: number }>(
      `SELECT COUNT(*)::int AS total_students FROM students WHERE school_id = $1`,
      [schoolId]
    ),
    pool.query<{ school_average: string | null; students_with_scores: number; pass_count: number; judged_count: number }>(
      `${JUDGED_TOTALS}
       SELECT
         ROUND(AVG(subject_total)::numeric, 2) AS school_average,
         COUNT(DISTINCT student_id)::int AS students_with_scores,
         COUNT(*) FILTER (WHERE pass_mark IS NOT NULL AND subject_total >= pass_mark)::int AS pass_count,
         COUNT(*) FILTER (WHERE pass_mark IS NOT NULL)::int AS judged_count
       FROM judged`,
      [schoolId, termId, JSON.stringify(marks.byLevel), marks.school]
    ),
  ]);

  const perf = perfResult.rows[0];
  const judgedCount = Number(perf?.judged_count ?? 0);
  const passCount = Number(perf?.pass_count ?? 0);

  return {
    total_students: Number(studentsResult.rows[0]?.total_students ?? 0),
    students_with_scores: Number(perf?.students_with_scores ?? 0),
    school_average: perf?.school_average !== null && perf?.school_average !== undefined ? Number(perf.school_average) : null,
    pass_rate: judgedCount > 0 ? Math.round((passCount / judgedCount) * 10000) / 100 : null,
    pass_mark: marks.school,
  };
}

export async function computeSubjectPerformance(schoolId: string, termId: string): Promise<SubjectPerformanceRow[]> {
  const marks = await fetchPassMarks(schoolId);
  const result = await pool.query<{
    subject_id: string;
    subject_name: string;
    average: string | null;
    pass_count: number;
    judged_count: number;
    students_count: number;
  }>(
    `${JUDGED_TOTALS}
     SELECT
       sub.id AS subject_id,
       sub.name AS subject_name,
       ROUND(AVG(j.subject_total)::numeric, 2) AS average,
       COUNT(*) FILTER (WHERE j.pass_mark IS NOT NULL AND j.subject_total >= j.pass_mark)::int AS pass_count,
       COUNT(*) FILTER (WHERE j.pass_mark IS NOT NULL)::int AS judged_count,
       COUNT(*)::int AS students_count
     FROM judged j
     JOIN subjects sub ON sub.id = j.subject_id
     GROUP BY sub.id, sub.name
     ORDER BY sub.name`,
    [schoolId, termId, JSON.stringify(marks.byLevel), marks.school]
  );

  return result.rows.map((row) => {
    const judgedCount = Number(row.judged_count);
    const passCount = Number(row.pass_count);
    return {
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      average: row.average !== null ? Number(row.average) : 0,
      pass_rate: judgedCount > 0 ? Math.round((passCount / judgedCount) * 10000) / 100 : null,
      students_count: Number(row.students_count),
    };
  });
}

export async function computeAttendanceSummary(schoolId: string, termId: string): Promise<AttendanceSummaryData> {
  const result = await pool.query<{ present: number; absent: number; late: number; excused: number; total: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'present')::int AS present,
       COUNT(*) FILTER (WHERE status = 'absent')::int  AS absent,
       COUNT(*) FILTER (WHERE status = 'late')::int    AS late,
       COUNT(*) FILTER (WHERE status = 'excused')::int AS excused,
       COUNT(*)::int AS total
     FROM attendance
     WHERE school_id = $1 AND term_id = $2`,
    [schoolId, termId]
  );

  const row = result.rows[0];
  const present = Number(row?.present ?? 0);
  const absent = Number(row?.absent ?? 0);
  const late = Number(row?.late ?? 0);
  const excused = Number(row?.excused ?? 0);
  const total = Number(row?.total ?? 0);

  return {
    total,
    present,
    absent,
    late,
    excused,
    percentage: total === 0 ? 0 : Math.round(((present + late) / total) * 10000) / 100,
  };
}

export async function upsertSnapshot(
  schoolId: string,
  termId: string,
  snapshotDate: string,
  data: SnapshotData
): Promise<AnalyticsSnapshotRow> {
  const result = await pool.query<AnalyticsSnapshotRow>(
    `INSERT INTO school_analytics_snapshots
       (school_id, term_id, snapshot_date, overall_performance, subject_performance, attendance_summary, fee_collection)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (school_id, term_id, snapshot_date) DO UPDATE SET
       overall_performance = EXCLUDED.overall_performance,
       subject_performance = EXCLUDED.subject_performance,
       attendance_summary  = EXCLUDED.attendance_summary,
       fee_collection      = EXCLUDED.fee_collection
     RETURNING *`,
    [
      schoolId,
      termId,
      snapshotDate,
      JSON.stringify(data.overall_performance),
      JSON.stringify(data.subject_performance),
      JSON.stringify(data.attendance_summary),
      JSON.stringify(data.fee_collection),
    ]
  );
  return result.rows[0];
}

export async function getLatestSnapshot(schoolId: string, termId: string): Promise<AnalyticsSnapshotRow | null> {
  const result = await pool.query<AnalyticsSnapshotRow>(
    `SELECT * FROM school_analytics_snapshots
     WHERE school_id = $1 AND term_id = $2
     ORDER BY snapshot_date DESC
     LIMIT 1`,
    [schoolId, termId]
  );
  return result.rows[0] ?? null;
}

export async function getPreviousSnapshot(schoolId: string, termId: string, beforeDate: string): Promise<AnalyticsSnapshotRow | null> {
  const result = await pool.query<AnalyticsSnapshotRow>(
    `SELECT * FROM school_analytics_snapshots
     WHERE school_id = $1 AND term_id = $2 AND snapshot_date < $3
     ORDER BY snapshot_date DESC
     LIMIT 1`,
    [schoolId, termId, beforeDate]
  );
  return result.rows[0] ?? null;
}

export async function listSchoolsWithCurrentTerm(): Promise<SchoolTermPair[]> {
  const result = await pool.query<SchoolTermPair>(
    `SELECT t.school_id, t.id AS term_id
     FROM terms t
     JOIN academic_sessions s ON s.id = t.session_id
     WHERE t.is_current = TRUE AND s.is_current = TRUE`
  );
  return result.rows;
}
