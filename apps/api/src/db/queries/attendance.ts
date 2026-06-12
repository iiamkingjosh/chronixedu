import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

export interface AttendanceRow {
  id: string;
  school_id: string;
  student_id: string;
  class_id: string;
  term_id: string;
  date: string;
  status: AttendanceStatus;
  marked_by: string;
  created_at: string;
}

export interface AttendanceAlertRow {
  id: string;
  school_id: string;
  student_id: string;
  alert_type: string;
  triggered_at: string;
  is_resolved: boolean;
}

export interface RosterStudent {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
}

// ── Term lookup by date ────────────────────────────────────────────────────────

export interface TermRow {
  id: string;
  name: string;
  session_id: string;
}

export async function findTermForDate(schoolId: string, date: string): Promise<TermRow | null> {
  const result = await pool.query<TermRow>(
    `SELECT id, name, session_id FROM terms
     WHERE school_id = $1 AND start_date <= $2 AND end_date >= $2
     LIMIT 1`,
    [schoolId, date]
  );
  return result.rows[0] ?? null;
}

// ── Class roster ───────────────────────────────────────────────────────────────

export async function getClassRoster(classId: string, schoolId: string): Promise<RosterStudent[]> {
  const result = await pool.query<RosterStudent>(
    `SELECT s.id AS student_id, u.first_name, u.last_name, s.admission_no
     FROM students s
     JOIN users u ON u.id = s.user_id
     JOIN student_classes stc ON stc.student_id = s.id AND stc.class_id = $1
     WHERE s.school_id = $2
     ORDER BY u.last_name, u.first_name`,
    [classId, schoolId]
  );
  return result.rows;
}

// ── Mark attendance (bulk upsert — same-day correction allowed) ───────────────

export interface BulkAttendanceEntry {
  student_id: string;
  status: AttendanceStatus;
}

export async function bulkUpsertAttendance(
  schoolId: string,
  classId: string,
  termId: string,
  date: string,
  entries: BulkAttendanceEntry[],
  markedBy: string
): Promise<AttendanceRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved: AttendanceRow[] = [];
    for (const entry of entries) {
      const result = await client.query<AttendanceRow>(
        `INSERT INTO attendance (school_id, student_id, class_id, term_id, date, status, marked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (student_id, class_id, date) DO UPDATE
           SET status = EXCLUDED.status, term_id = EXCLUDED.term_id, marked_by = EXCLUDED.marked_by
         RETURNING id, school_id, student_id, class_id, term_id, date, status, marked_by, created_at`,
        [schoolId, entry.student_id, classId, termId, date, entry.status, markedBy]
      );
      saved.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return saved;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Low-attendance alerts ──────────────────────────────────────────────────────

export const LOW_ATTENDANCE_ALERT_TYPE = 'low_attendance';

export async function countRecentAbsences(studentId: string, schoolId: string, throughDate: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM attendance
     WHERE student_id = $1 AND school_id = $2 AND status = 'absent'
       AND date BETWEEN ($3::date - INTERVAL '6 days') AND $3::date`,
    [studentId, schoolId, throughDate]
  );
  return result.rows[0].count;
}

export async function hasUnresolvedAlert(studentId: string, schoolId: string, alertType: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM attendance_alerts
     WHERE student_id = $1 AND school_id = $2 AND alert_type = $3 AND is_resolved = FALSE`,
    [studentId, schoolId, alertType]
  );
  return result.rows.length > 0;
}

export async function insertAttendanceAlert(schoolId: string, studentId: string, alertType: string): Promise<AttendanceAlertRow> {
  const result = await pool.query<AttendanceAlertRow>(
    `INSERT INTO attendance_alerts (school_id, student_id, alert_type)
     VALUES ($1, $2, $3)
     RETURNING id, school_id, student_id, alert_type, triggered_at, is_resolved`,
    [schoolId, studentId, alertType]
  );
  return result.rows[0];
}

// ── GET /class — attendance for a class on a given date ───────────────────────

export interface ClassAttendanceRow extends RosterStudent {
  attendance_id: string | null;
  status: AttendanceStatus | null;
}

export async function getClassAttendanceForDate(
  classId: string,
  schoolId: string,
  date: string
): Promise<ClassAttendanceRow[]> {
  const result = await pool.query<ClassAttendanceRow>(
    `SELECT s.id AS student_id, u.first_name, u.last_name, s.admission_no,
            a.id AS attendance_id, a.status
     FROM students s
     JOIN users u ON u.id = s.user_id
     JOIN student_classes stc ON stc.student_id = s.id AND stc.class_id = $1
     LEFT JOIN attendance a ON a.student_id = s.id AND a.class_id = $1 AND a.date = $2
     WHERE s.school_id = $3
     ORDER BY u.last_name, u.first_name`,
    [classId, date, schoolId]
  );
  return result.rows;
}

// ── GET /student/:studentId — full-term history with percentage ───────────────

export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  late: number;
  excused: number;
  percentage: number;
}

export interface StudentAttendanceHistory {
  records: AttendanceRow[];
  summary: AttendanceSummary;
}

export async function getStudentAttendanceHistory(
  studentId: string,
  schoolId: string,
  termId: string
): Promise<StudentAttendanceHistory> {
  const [recordsResult, countsResult] = await Promise.all([
    pool.query<AttendanceRow>(
      `SELECT id, school_id, student_id, class_id, term_id, date, status, marked_by, created_at
       FROM attendance
       WHERE student_id = $1 AND school_id = $2 AND term_id = $3
       ORDER BY date DESC`,
      [studentId, schoolId, termId]
    ),
    pool.query<{ status: AttendanceStatus; count: number }>(
      `SELECT status, COUNT(*)::int AS count
       FROM attendance
       WHERE student_id = $1 AND school_id = $2 AND term_id = $3
       GROUP BY status`,
      [studentId, schoolId, termId]
    ),
  ]);

  const counts: Record<AttendanceStatus, number> = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const row of countsResult.rows) counts[row.status] = row.count;

  const total = counts.present + counts.absent + counts.late + counts.excused;
  // "late" counts toward attendance (the student showed up); percentage is share of present+late out of all recorded days.
  const percentage = total === 0 ? 0 : Math.round(((counts.present + counts.late) / total) * 10000) / 100;

  return {
    records: recordsResult.rows,
    summary: { total, ...counts, percentage },
  };
}

// ── GET /monthly-summary — per-student attendance percentage for a month ──────

export interface MonthlySummaryRow extends RosterStudent {
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  percentage: number;
}

export async function getMonthlySummary(
  classId: string,
  schoolId: string,
  month: number,
  year: number
): Promise<MonthlySummaryRow[]> {
  const result = await pool.query<RosterStudent & { present: number; absent: number; late: number; excused: number; total: number }>(
    `SELECT
       s.id AS student_id, u.first_name, u.last_name, s.admission_no,
       COUNT(*) FILTER (WHERE a.status = 'present')::int AS present,
       COUNT(*) FILTER (WHERE a.status = 'absent')::int  AS absent,
       COUNT(*) FILTER (WHERE a.status = 'late')::int    AS late,
       COUNT(*) FILTER (WHERE a.status = 'excused')::int AS excused,
       COUNT(a.id)::int AS total
     FROM students s
     JOIN users u ON u.id = s.user_id
     JOIN student_classes stc ON stc.student_id = s.id AND stc.class_id = $1
     LEFT JOIN attendance a ON a.student_id = s.id AND a.class_id = $1
       AND EXTRACT(MONTH FROM a.date) = $2 AND EXTRACT(YEAR FROM a.date) = $3
     WHERE s.school_id = $4
     GROUP BY s.id, u.first_name, u.last_name, s.admission_no
     ORDER BY u.last_name, u.first_name`,
    [classId, month, year, schoolId]
  );

  return result.rows.map(row => ({
    ...row,
    percentage: row.total === 0 ? 0 : Math.round(((row.present + row.late) / row.total) * 10000) / 100,
  }));
}

// ── School-wide attendance % per class for a term ─────────────────────────────

export interface ClassTermSummaryRow {
  class_id: string;
  class_name: string;
  present: number;
  absent: number;
  late: number;
  excused: number;
  total: number;
  percentage: number;
}

export async function getClassTermSummary(schoolId: string, termId: string): Promise<ClassTermSummaryRow[]> {
  const result = await pool.query<Omit<ClassTermSummaryRow, 'percentage'>>(
    `SELECT
       c.id AS class_id, c.name AS class_name,
       COUNT(*) FILTER (WHERE a.status = 'present')::int AS present,
       COUNT(*) FILTER (WHERE a.status = 'absent')::int  AS absent,
       COUNT(*) FILTER (WHERE a.status = 'late')::int    AS late,
       COUNT(*) FILTER (WHERE a.status = 'excused')::int AS excused,
       COUNT(a.id)::int AS total
     FROM classes c
     LEFT JOIN attendance a ON a.class_id = c.id AND a.term_id = $2
     WHERE c.school_id = $1
     GROUP BY c.id, c.name
     ORDER BY c.name`,
    [schoolId, termId]
  );

  return result.rows.map(row => ({
    ...row,
    percentage: row.total === 0 ? 0 : Math.round(((row.present + row.late) / row.total) * 10000) / 100,
  }));
}

// ── Chronic absenteeism — unresolved low-attendance alerts ────────────────────

export interface AttendanceAlertWithStudent {
  id: string;
  student_id: string;
  alert_type: string;
  triggered_at: string;
  is_resolved: boolean;
  first_name: string;
  last_name: string;
  admission_no: string;
}

export async function listUnresolvedAlerts(schoolId: string): Promise<AttendanceAlertWithStudent[]> {
  const result = await pool.query<AttendanceAlertWithStudent>(
    `SELECT al.id, al.student_id, al.alert_type, al.triggered_at, al.is_resolved,
            u.first_name, u.last_name, s.admission_no
     FROM attendance_alerts al
     JOIN students s ON s.id = al.student_id
     JOIN users u ON u.id = s.user_id
     WHERE al.school_id = $1 AND al.is_resolved = FALSE
     ORDER BY al.triggered_at DESC`,
    [schoolId]
  );
  return result.rows;
}
