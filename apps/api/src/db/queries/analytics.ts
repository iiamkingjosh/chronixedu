import pool from '../client';
import { CollectionSummary } from './fees';

/** Minimum subject_total (%) considered a passing grade — matches the "D / Pass" floor in the default grading scale. */
export const PASS_MARK = 40;

export interface OverallPerformance {
  total_students: number;
  students_with_scores: number;
  school_average: number | null;
  pass_rate: number | null;
}

export interface SubjectPerformanceRow {
  subject_id: string;
  subject_name: string;
  average: number;
  pass_rate: number;
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
  const [studentsResult, perfResult] = await Promise.all([
    pool.query<{ total_students: number }>(
      `SELECT COUNT(*)::int AS total_students FROM students WHERE school_id = $1`,
      [schoolId]
    ),
    pool.query<{ school_average: string | null; students_with_scores: number; pass_count: number; total_count: number }>(
      `SELECT
         ROUND(AVG(t.subject_total)::numeric, 2) AS school_average,
         COUNT(DISTINCT t.student_id)::int AS students_with_scores,
         COUNT(*) FILTER (WHERE t.subject_total >= $3)::int AS pass_count,
         COUNT(*)::int AS total_count
       FROM (
         SELECT sc.student_id, sc.subject_id,
           SUM(sc.score / NULLIF(ac.max_score, 0)::float * ac.weight_percent) AS subject_total
         FROM scores sc
         JOIN assessment_components ac ON ac.id = sc.component_id
         WHERE sc.school_id = $1 AND sc.term_id = $2
         GROUP BY sc.student_id, sc.subject_id
       ) t`,
      [schoolId, termId, PASS_MARK]
    ),
  ]);

  const perf = perfResult.rows[0];
  const totalCount = Number(perf?.total_count ?? 0);
  const passCount = Number(perf?.pass_count ?? 0);

  return {
    total_students: Number(studentsResult.rows[0]?.total_students ?? 0),
    students_with_scores: Number(perf?.students_with_scores ?? 0),
    school_average: perf?.school_average !== null && perf?.school_average !== undefined ? Number(perf.school_average) : null,
    pass_rate: totalCount > 0 ? Math.round((passCount / totalCount) * 10000) / 100 : null,
  };
}

export async function computeSubjectPerformance(schoolId: string, termId: string): Promise<SubjectPerformanceRow[]> {
  const result = await pool.query<{
    subject_id: string;
    subject_name: string;
    average: string | null;
    pass_count: number;
    students_count: number;
  }>(
    `SELECT
       sub.id AS subject_id,
       sub.name AS subject_name,
       ROUND(AVG(t.subject_total)::numeric, 2) AS average,
       COUNT(*) FILTER (WHERE t.subject_total >= $3)::int AS pass_count,
       COUNT(*)::int AS students_count
     FROM (
       SELECT sc.student_id, sc.subject_id,
         SUM(sc.score / NULLIF(ac.max_score, 0)::float * ac.weight_percent) AS subject_total
       FROM scores sc
       JOIN assessment_components ac ON ac.id = sc.component_id
       WHERE sc.school_id = $1 AND sc.term_id = $2
       GROUP BY sc.student_id, sc.subject_id
     ) t
     JOIN subjects sub ON sub.id = t.subject_id
     GROUP BY sub.id, sub.name
     ORDER BY sub.name`,
    [schoolId, termId, PASS_MARK]
  );

  return result.rows.map((row) => {
    const studentsCount = Number(row.students_count);
    const passCount = Number(row.pass_count);
    return {
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      average: row.average !== null ? Number(row.average) : 0,
      pass_rate: studentsCount > 0 ? Math.round((passCount / studentsCount) * 10000) / 100 : 0,
      students_count: studentsCount,
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
