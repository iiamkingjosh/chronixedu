import pool from '../client';

export interface DashboardStats {
  total_students: number;
  total_teachers: number;
  total_classes:  number;
  session_name:   string | null;
  term_name:      string | null;
  term_id:        string | null;
  school_average: number | null;
}

export interface TeacherActivity {
  teacher_id:          string;
  first_name:          string;
  last_name:           string;
  email:               string;
  subjects_assigned:   number;
  classes_assigned:    number;
  submitted:           number;
  pending:             number;
  last_score_entry_at: string | null;
}

export async function getDashboardStats(schoolId: string): Promise<DashboardStats> {
  const [counts, term] = await Promise.all([
    pool.query<{ total_students: string; total_teachers: string; total_classes: string }>(
      `SELECT
         (SELECT COUNT(*) FROM students  WHERE school_id = $1)::int AS total_students,
         (SELECT COUNT(*) FROM users     WHERE school_id = $1 AND role = 'teacher')::int AS total_teachers,
         (SELECT COUNT(*) FROM classes   WHERE school_id = $1)::int AS total_classes`,
      [schoolId]
    ),
    pool.query<{ session_name: string; term_name: string; term_id: string }>(
      `SELECT sess.name AS session_name, t.name AS term_name, t.id AS term_id
       FROM academic_sessions sess
       JOIN terms t ON t.session_id = sess.id AND t.is_current = TRUE AND t.school_id = $1
       WHERE sess.school_id = $1 AND sess.is_current = TRUE
       LIMIT 1`,
      [schoolId]
    ),
  ]);

  const row    = counts.rows[0];
  const termRow = term.rows[0] ?? null;

  let school_average: number | null = null;
  if (termRow) {
    const avgResult = await pool.query<{ school_average: string | null }>(
      `SELECT ROUND(AVG(subject_total)::numeric, 2) AS school_average
       FROM (
         SELECT
           sc.student_id,
           sc.subject_id,
           SUM(sc.score / NULLIF(ac.max_score, 0)::float * ac.weight_percent) AS subject_total
         FROM scores sc
         JOIN assessment_components ac ON ac.id = sc.component_id
         WHERE sc.school_id = $1 AND sc.term_id = $2
         GROUP BY sc.student_id, sc.subject_id
       ) t`,
      [schoolId, termRow.term_id]
    );
    const raw = avgResult.rows[0]?.school_average;
    school_average = raw !== null && raw !== undefined ? parseFloat(raw) : null;
  }

  return {
    total_students: Number(row.total_students),
    total_teachers: Number(row.total_teachers),
    total_classes:  Number(row.total_classes),
    session_name:   termRow?.session_name ?? null,
    term_name:      termRow?.term_name    ?? null,
    term_id:        termRow?.term_id      ?? null,
    school_average,
  };
}

export async function getUserName(
  userId: string
): Promise<{ first_name: string; last_name: string } | null> {
  const result = await pool.query<{ first_name: string; last_name: string }>(
    `SELECT first_name, last_name FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

// ── Teacher dashboard queries ──────────────────────────────────────────────────

export interface TeacherOverview {
  teacher_mode:          string;
  pending_score_entries: number;
  results_submitted:     number;
  results_pending:       number;
}

export interface ScoreEntryStatus {
  class_id:        string;
  class_name:      string;
  subject_id:      string;
  subject_name:    string;
  students_total:  number;
  students_scored: number;
  students_missing: number;
  result_status:   string;
}

export interface TeacherStudent {
  student_id:      string;
  first_name:      string;
  last_name:       string;
  admission_no:    string;
  overall_average: number;
}

export interface TeacherNotification {
  id:                string;
  notification_type: string | null;
  reason:            string | null;
  class_id:          string | null;
  created_at:        string;
}

export async function getTeacherOverview(
  teacherId: string,
  schoolId: string,
  termId: string
): Promise<TeacherOverview> {
  const result = await pool.query<{
    teacher_mode: string;
    pending_score_entries: string;
    results_submitted: string;
    results_pending: string;
  }>(
    `WITH submitted_classes AS (
       SELECT DISTINCT stc.class_id
       FROM result_status rs
       JOIN student_classes stc ON stc.student_id = rs.student_id
       WHERE rs.term_id   = $3
         AND rs.school_id = $2
         AND rs.status    = ANY(ARRAY['submitted','approved','published']::chronixedu_result_status[])
         AND stc.class_id IN (
           SELECT DISTINCT class_id FROM teacher_assignments
           WHERE teacher_id = $1 AND school_id = $2 AND term_id = $3
         )
     ),
     teacher_classes AS (
       SELECT DISTINCT class_id FROM teacher_assignments
       WHERE teacher_id = $1 AND school_id = $2 AND term_id = $3
     ),
     missing_scores AS (
       SELECT COUNT(DISTINCT (ta.class_id, ta.subject_id, stc.student_id)) AS cnt
       FROM teacher_assignments ta
       JOIN student_classes stc ON stc.class_id = ta.class_id
       WHERE ta.teacher_id = $1 AND ta.school_id = $2 AND ta.term_id = $3
         AND NOT EXISTS (
           SELECT 1 FROM scores sc
           WHERE sc.student_id = stc.student_id
             AND sc.subject_id = ta.subject_id
             AND sc.term_id    = $3
             AND sc.school_id  = $2
         )
     )
     SELECT
       u.teacher_mode,
       (SELECT cnt FROM missing_scores)::int                  AS pending_score_entries,
       (SELECT COUNT(*) FROM submitted_classes)::int          AS results_submitted,
       GREATEST(
         (SELECT COUNT(*) FROM teacher_classes)::int -
         (SELECT COUNT(*) FROM submitted_classes)::int, 0
       )                                                       AS results_pending
     FROM users u
     WHERE u.id = $1`,
    [teacherId, schoolId, termId]
  );

  const row = result.rows[0];
  return {
    teacher_mode:          row?.teacher_mode           ?? 'subject',
    pending_score_entries: Number(row?.pending_score_entries ?? 0),
    results_submitted:     Number(row?.results_submitted     ?? 0),
    results_pending:       Number(row?.results_pending       ?? 0),
  };
}

export async function getTeacherScoreEntryStatus(
  teacherId: string,
  schoolId: string,
  termId: string
): Promise<ScoreEntryStatus[]> {
  const result = await pool.query<ScoreEntryStatus>(
    `WITH class_submitted AS (
       SELECT DISTINCT stc.class_id
       FROM result_status rs
       JOIN student_classes stc ON stc.student_id = rs.student_id
       WHERE rs.term_id   = $3
         AND rs.school_id = $2
         AND rs.status    = ANY(ARRAY['submitted','approved','published']::chronixedu_result_status[])
     )
     SELECT
       ta.class_id,
       c.name                                                                 AS class_name,
       ta.subject_id,
       sub.name                                                               AS subject_name,
       COUNT(DISTINCT stc.student_id)::int                                    AS students_total,
       COUNT(DISTINCT sc.student_id)::int                                     AS students_scored,
       (COUNT(DISTINCT stc.student_id) - COUNT(DISTINCT sc.student_id))::int AS students_missing,
       CASE WHEN cs.class_id IS NOT NULL THEN 'submitted' ELSE 'draft' END   AS result_status
     FROM teacher_assignments ta
     JOIN classes c     ON c.id   = ta.class_id
     JOIN subjects sub  ON sub.id = ta.subject_id
     JOIN student_classes stc ON stc.class_id = ta.class_id
     LEFT JOIN scores sc
       ON sc.student_id = stc.student_id
      AND sc.subject_id = ta.subject_id
      AND sc.term_id    = $3
      AND sc.school_id  = $2
     LEFT JOIN class_submitted cs ON cs.class_id = ta.class_id
     WHERE ta.teacher_id = $1 AND ta.school_id = $2 AND ta.term_id = $3
     GROUP BY ta.class_id, c.name, c.level, ta.subject_id, sub.name, cs.class_id
     ORDER BY c.level, c.name, sub.name`,
    [teacherId, schoolId, termId]
  );
  return result.rows;
}

export async function getStudentsInClassWithAverages(
  classId: string,
  schoolId: string,
  termId: string
): Promise<TeacherStudent[]> {
  const result = await pool.query<TeacherStudent>(
    `SELECT
       s.id             AS student_id,
       u.first_name,
       u.last_name,
       s.admission_no,
       COALESCE(
         ROUND(AVG(subj.subject_total)::numeric, 2), 0
       )::float         AS overall_average
     FROM students s
     JOIN users u ON u.id = s.user_id
     JOIN student_classes stc ON stc.student_id = s.id AND stc.class_id = $1
     LEFT JOIN (
       SELECT
         sc.student_id,
         SUM(sc.score / NULLIF(ac.max_score, 0)::float * ac.weight_percent) AS subject_total
       FROM scores sc
       JOIN assessment_components ac ON ac.id = sc.component_id
       WHERE sc.term_id = $3 AND sc.school_id = $2
       GROUP BY sc.student_id, sc.subject_id
     ) subj ON subj.student_id = s.id
     WHERE s.school_id = $2
     GROUP BY s.id, u.first_name, u.last_name, s.admission_no
     ORDER BY u.last_name, u.first_name`,
    [classId, schoolId, termId]
  );
  return result.rows;
}

export async function getTeacherNotifications(
  teacherId: string,
  schoolId: string
): Promise<TeacherNotification[]> {
  const result = await pool.query<TeacherNotification>(
    `SELECT
       id,
       new_value->>'notification_type' AS notification_type,
       new_value->>'reason'            AS reason,
       entity_id                       AS class_id,
       created_at::text                AS created_at
     FROM audit_logs
     WHERE school_id   = $1
       AND action_type = 'TEACHER_NOTIFICATION_QUEUED'
       AND new_value->'teacher_ids' @> to_jsonb($2::text)
     ORDER BY created_at DESC
     LIMIT 20`,
    [schoolId, teacherId]
  );
  return result.rows;
}

export async function getTeacherActivity(
  schoolId: string,
  termId: string
): Promise<TeacherActivity[]> {
  const result = await pool.query<TeacherActivity>(
    `WITH class_submitted AS (
       SELECT DISTINCT stc.class_id
       FROM result_status rs
       JOIN student_classes stc ON stc.student_id = rs.student_id
       WHERE rs.term_id   = $2
         AND rs.school_id = $1
         AND rs.status    = ANY(ARRAY['submitted','approved','published']::chronixedu_result_status[])
     ),
     teacher_stats AS (
       SELECT
         ta.teacher_id,
         COUNT(DISTINCT ta.subject_id)                                                AS subjects_assigned,
         COUNT(DISTINCT ta.class_id)                                                  AS classes_assigned,
         COUNT(DISTINCT CASE WHEN cs.class_id IS NOT NULL THEN ta.class_id END)       AS submitted
       FROM teacher_assignments ta
       LEFT JOIN class_submitted cs ON cs.class_id = ta.class_id
       WHERE ta.school_id = $1 AND ta.term_id = $2
       GROUP BY ta.teacher_id
     ),
     last_entry AS (
       SELECT entered_by AS teacher_id, MAX(updated_at)::text AS last_score_entry_at
       FROM scores
       WHERE school_id = $1 AND term_id = $2 AND entered_by IS NOT NULL
       GROUP BY entered_by
     )
     SELECT
       u.id                                                    AS teacher_id,
       u.first_name,
       u.last_name,
       u.email,
       COALESCE(ts.subjects_assigned, 0)::int                 AS subjects_assigned,
       COALESCE(ts.classes_assigned,  0)::int                 AS classes_assigned,
       COALESCE(ts.submitted,         0)::int                 AS submitted,
       GREATEST(COALESCE(ts.classes_assigned, 0) - COALESCE(ts.submitted, 0), 0)::int AS pending,
       le.last_score_entry_at
     FROM users u
     LEFT JOIN teacher_stats ts ON ts.teacher_id = u.id
     LEFT JOIN last_entry    le ON le.teacher_id = u.id
     WHERE u.school_id = $1 AND u.role = 'teacher'
     ORDER BY u.last_name, u.first_name`,
    [schoolId, termId]
  );
  return result.rows;
}
