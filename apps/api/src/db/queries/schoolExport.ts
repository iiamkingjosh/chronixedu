import pool from '../client';
import { csvCell } from '../../services/csv';

/**
 * A school's complete data export — what the Data Processing Agreement and Terms §22
 * promise on termination ("a complete export … in CSV or PDF"), and what the read-only
 * notice promises a lapsed school ("viewed and exported").
 *
 * The export that existed before was one CSV of students' names, classes and dates of birth,
 * reachable only by a Chronix super admin. It is now every table the school would consider
 * its own, one CSV each, downloadable by the school's principal.
 *
 * COMPLETENESS IS TESTED, not asserted: schoolExport.db.test.ts reads every table in the
 * database and fails unless each one is either an EXPORT_DATASETS source or listed in
 * NOT_EXPORTED with its reason. A table added without that decision fails CI.
 *
 * Every query takes the school id as $1 and is scoped by it — directly on school_id, or
 * through the school's students, terms or assignments for tables that have no school_id.
 * Nothing here returns a secret: users.password_hash is left out by name.
 */
export interface ExportDataset {
  key: string;
  label: string;
  /** The tables this dataset draws its rows from — what the completeness test reads. */
  tables: string[];
  sql: string;
}

const STUDENTS = `(SELECT id FROM students WHERE school_id = $1)`;
const TERMS = `(SELECT id FROM terms WHERE school_id = $1)`;

export const EXPORT_DATASETS: ExportDataset[] = [
  { key: 'students', label: 'Students', tables: ['students'],
    sql: `SELECT s.*, u.first_name, u.last_name, u.email, u.is_active
            FROM students s JOIN users u ON u.id = s.user_id WHERE s.school_id = $1 ORDER BY s.admission_no` },
  { key: 'people', label: 'Staff, parents and student accounts', tables: ['users'],
    sql: `SELECT id, role, title, first_name, last_name, email, phone, is_active, teacher_mode, created_at, last_login_at
            FROM users WHERE school_id = $1 ORDER BY role, last_name, first_name` },
  { key: 'parent_links', label: 'Parent–student links', tables: ['parent_students'],
    sql: `SELECT * FROM parent_students WHERE student_id IN ${STUDENTS}` },
  { key: 'sessions', label: 'Academic sessions', tables: ['academic_sessions'],
    sql: `SELECT * FROM academic_sessions WHERE school_id = $1 ORDER BY start_date` },
  { key: 'terms', label: 'Terms', tables: ['terms'], sql: `SELECT * FROM terms WHERE school_id = $1 ORDER BY start_date` },
  { key: 'classes', label: 'Classes', tables: ['classes'], sql: `SELECT * FROM classes WHERE school_id = $1 ORDER BY name` },
  { key: 'subjects', label: 'Subjects', tables: ['subjects'], sql: `SELECT * FROM subjects WHERE school_id = $1 ORDER BY name` },
  { key: 'enrolments', label: 'Class enrolments', tables: ['student_classes'],
    sql: `SELECT * FROM student_classes WHERE student_id IN ${STUDENTS}` },
  { key: 'teacher_assignments', label: 'Teacher assignments', tables: ['teacher_assignments'],
    sql: `SELECT * FROM teacher_assignments WHERE school_id = $1` },
  { key: 'assessment_configs', label: 'Assessment configurations', tables: ['assessment_configs'],
    sql: `SELECT * FROM assessment_configs WHERE school_id = $1` },
  { key: 'assessment_components', label: 'Assessment components', tables: ['assessment_components'],
    sql: `SELECT * FROM assessment_components WHERE config_id IN (SELECT id FROM assessment_configs WHERE school_id = $1)` },
  { key: 'scores', label: 'Scores', tables: ['scores'], sql: `SELECT * FROM scores WHERE school_id = $1` },
  { key: 'subject_result_status', label: 'Subject result status', tables: ['subject_result_status'],
    sql: `SELECT * FROM subject_result_status WHERE school_id = $1` },
  { key: 'result_status', label: 'Result status', tables: ['result_status'], sql: `SELECT * FROM result_status WHERE school_id = $1` },
  { key: 'report_cards', label: 'Report cards', tables: ['report_cards'], sql: `SELECT * FROM report_cards WHERE school_id = $1` },
  { key: 'class_comments', label: 'Class teacher comments', tables: ['class_teacher_comments'],
    sql: `SELECT * FROM class_teacher_comments WHERE student_id IN ${STUDENTS} OR term_id IN ${TERMS}` },
  { key: 'principal_remarks', label: 'Principal remarks', tables: ['principal_remarks'],
    sql: `SELECT * FROM principal_remarks WHERE student_id IN ${STUDENTS} OR term_id IN ${TERMS}` },
  { key: 'attendance', label: 'Attendance', tables: ['attendance'], sql: `SELECT * FROM attendance WHERE school_id = $1 ORDER BY date` },
  { key: 'behaviour', label: 'Behaviour records', tables: ['behaviour_records'], sql: `SELECT * FROM behaviour_records WHERE school_id = $1` },
  { key: 'assignments', label: 'Assignments', tables: ['assignments'], sql: `SELECT * FROM assignments WHERE school_id = $1` },
  { key: 'assignment_submissions', label: 'Assignment submissions', tables: ['assignment_submissions'],
    sql: `SELECT * FROM assignment_submissions WHERE assignment_id IN (SELECT id FROM assignments WHERE school_id = $1)` },
  { key: 'timetable', label: 'Timetable', tables: ['timetable_slots'], sql: `SELECT * FROM timetable_slots WHERE school_id = $1` },
  { key: 'notices', label: 'Class notices', tables: ['notices'], sql: `SELECT * FROM notices WHERE school_id = $1` },
  { key: 'announcements', label: 'Announcements', tables: ['announcements'], sql: `SELECT * FROM announcements WHERE school_id = $1` },
  { key: 'messages', label: 'Messages', tables: ['messages'], sql: `SELECT * FROM messages WHERE school_id = $1` },
  { key: 'fee_structures', label: 'Fee structures', tables: ['fee_structures'], sql: `SELECT * FROM fee_structures WHERE school_id = $1` },
  { key: 'fee_invoices', label: 'Fee invoices', tables: ['fee_invoices'], sql: `SELECT * FROM fee_invoices WHERE school_id = $1` },
  { key: 'payments', label: 'Fee payments', tables: ['payments'], sql: `SELECT * FROM payments WHERE school_id = $1` },
  { key: 'settings', label: 'School settings', tables: ['school_settings'], sql: `SELECT * FROM school_settings WHERE school_id = $1` },
  { key: 'audit_log', label: 'Audit log', tables: ['audit_logs'], sql: `SELECT * FROM audit_logs WHERE school_id = $1 ORDER BY created_at` },
];

/** Every table in the database that is NOT a dataset, and why. The completeness test reads this. */
export const NOT_EXPORTED: Record<string, string> = {
  schools: "The school's own row: its name, slug and flags are in the settings export; payout bank details are kept out of a file that gets emailed around.",
  attendance_alerts: 'Derived: raised automatically from attendance, which is exported in full.',
  school_analytics_snapshots: 'Derived: dashboard figures recomputed from the exported data.',
  notification_logs: 'Delivery log of messages sent on the school’s behalf — operational, not school records.',
  notifications: 'Per-user in-app notifications generated from events that are themselves exported.',
  email_queue: 'Transient: SendGrid refusals awaiting retry, each deleted after 7 days (EMAIL_QUEUE_RETENTION_DAYS, since 2 Oct 2026; before that nothing deleted them). Holds no record the school created.',
  support_sessions: 'Chronix’s record of its own support access — Chronix’s audit, available on request.',
  onboarding_sessions: 'Chronix’s record of setting the school up.',
  platform_subscriptions: 'The commercial relationship between the school and Chronix, not school data; available from Chronix.',
  platform_subscription_payments: 'The school’s payments to Chronix for its own subscription (migration 052) — the commercial relationship between the school and Chronix, same reasoning as platform_subscriptions; available from Chronix.',
  platform_audit_logs: 'Chronix’s audit of its own administrators’ actions.',
  platform_announcements: 'Platform-wide messages from Chronix to all schools.',
  platform_metrics_snapshots: 'Platform-wide aggregate figures; no single school’s data.',
  platform_pricing_config: 'The platform rate; no school data.',
  user_totp: 'A sign-in credential (an encrypted authenticator secret, migration 055), never part of an export: anyone holding it can sign in as that person.',
  user_recovery_codes: 'Sign-in credentials (hashes of one-time recovery codes, migration 055), never part of an export.',
  login_challenges: 'Minutes-long sign-in challenges for platform admins (migration 057): hashes of one-time values, no school data, and nothing a school would want back.',
  schema_migrations: 'Database bookkeeping.',
  migration_runs: 'Database bookkeeping.',
};

function cellValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Row counts for every dataset — what the export page lists. */
export async function exportSummary(schoolId: string): Promise<Array<{ key: string; label: string; rows: number }>> {
  const out = [];
  for (const d of EXPORT_DATASETS) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${d.sql}) x`, [schoolId]);
    out.push({ key: d.key, label: d.label, rows: Number(rows[0].n) });
  }
  return out;
}

/** One dataset as CSV (header row from the query's own columns), or null for an unknown key. */
export async function exportDatasetCsv(schoolId: string, key: string): Promise<{ filename: string; csv: string; rows: number } | null> {
  const d = EXPORT_DATASETS.find(x => x.key === key);
  if (!d) return null;
  const result = await pool.query(d.sql, [schoolId]);
  const header = result.fields.map(f => csvCell(f.name)).join(',');
  const lines = result.rows.map(r => result.fields.map(f => csvCell(cellValue(r[f.name]))).join(','));
  return { filename: `${d.key}.csv`, csv: [header, ...lines].join('\n'), rows: result.rows.length };
}
