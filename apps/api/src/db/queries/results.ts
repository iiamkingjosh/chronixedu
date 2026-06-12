import pool from '../client';
import { resolveAssessmentConfig } from './assessmentConfig';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MissingScore {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  missing_components: string[];
}

export interface SubjectCompletionResult {
  total_students: number;
  fully_scored: number;
  missing: MissingScore[]; // students with ≥1 component unscored
}

export interface StudentWithStatus {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  current_status: string | null; // null = no result_status row (implicit 'draft')
}

export interface ClassSubjectAssignment {
  class_id: string;
  assignment_id: string;
  subject_id: string;
  subject_name: string;
  subject_code: string;
  teacher_id: string;
  teacher_first_name: string;
  teacher_last_name: string;
}

export interface SubjectStatusInfo {
  subject_id: string;
  subject_name: string;
  subject_code: string;
  teacher_id: string;
  teacher_name: string;
  total_students: number;
  fully_scored_students: number;
  completion_pct: number;
  is_complete: boolean;
}

export interface ClassStatusSummary {
  draft: number;
  submitted: number;
  approved: number;
  published: number;
}

export interface ClassDashboardEntry {
  class_id: string;
  class_name: string;
  class_level: string;
  total_students: number;
  subjects: SubjectStatusInfo[];
  status_summary: ClassStatusSummary;
  all_subjects_complete: boolean;
  can_approve: boolean;  // all subjects complete AND all students submitted
  can_publish: boolean;  // all students approved
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type BulkConfig = {
  subject_id: string | null;
  class_level: string | null;
  is_default: boolean;
  components: Array<{ id: string; name: string }> | null;
};

/**
 * In-memory config priority resolution — mirrors the SQL CASE in resolveAssessmentConfig.
 * Used by the dashboard to avoid N×M DB round-trips.
 */
function resolveConfigFromBulk(
  configs: BulkConfig[],
  classLevel: string | null,
  subjectId: string
): BulkConfig | null {
  let best: BulkConfig | null = null;
  let bestPriority = 0;

  for (const cfg of configs) {
    let p = 0;
    if (cfg.subject_id === subjectId && cfg.class_level === classLevel) p = 4;
    else if (cfg.subject_id === subjectId && cfg.class_level === null)  p = 3;
    else if (cfg.subject_id === null && cfg.class_level === classLevel) p = 2;
    else if (cfg.is_default)                                            p = 1;
    if (p > bestPriority) { bestPriority = p; best = cfg; }
  }
  return best;
}

// ── Queries ────────────────────────────────────────────────────────────────────

/** All enrolled students for a class+term with their current result_status. */
export async function getStudentsInClassWithStatus(
  classId: string,
  termId: string,
  schoolId: string
): Promise<StudentWithStatus[]> {
  const result = await pool.query<StudentWithStatus>(
    `SELECT s.id AS student_id, u.first_name, u.last_name, s.admission_no,
            rs.status AS current_status
     FROM student_classes sc
     JOIN students s ON s.id = sc.student_id
     JOIN users   u ON u.id = s.user_id
     LEFT JOIN result_status rs
       ON rs.student_id = s.id AND rs.term_id = $2 AND rs.school_id = $3
     WHERE sc.class_id    = $1
       AND sc.session_id  = (SELECT session_id FROM terms WHERE id = $2)
     ORDER BY u.last_name, u.first_name`,
    [classId, termId, schoolId]
  );
  return result.rows;
}

/**
 * Validate that all enrolled students have scores for every required component
 * of a specific subject. Returns the list of students with missing components.
 */
export async function checkSubjectCompletion(
  schoolId: string,
  classId: string,
  subjectId: string,
  termId: string
): Promise<SubjectCompletionResult> {
  const config = await resolveAssessmentConfig(schoolId, classId, subjectId, termId);
  if (!config || config.components.length === 0) {
    return { total_students: 0, fully_scored: 0, missing: [] };
  }

  const studentsRes = await pool.query<{
    student_id: string; first_name: string; last_name: string; admission_no: string;
  }>(
    `SELECT s.id AS student_id, u.first_name, u.last_name, s.admission_no
     FROM student_classes sc
     JOIN students s ON s.id = sc.student_id
     JOIN users   u ON u.id = s.user_id
     WHERE sc.class_id   = $1
       AND sc.session_id = (SELECT session_id FROM terms WHERE id = $2)
     ORDER BY u.last_name, u.first_name`,
    [classId, termId]
  );

  const students = studentsRes.rows;
  if (students.length === 0) return { total_students: 0, fully_scored: 0, missing: [] };

  const scoresRes = await pool.query<{ student_id: string; component_id: string }>(
    `SELECT student_id, component_id FROM scores
     WHERE subject_id = $1 AND term_id = $2 AND student_id = ANY($3::uuid[])`,
    [subjectId, termId, students.map(s => s.student_id)]
  );

  const scoreIndex = new Map<string, Set<string>>();
  for (const row of scoresRes.rows) {
    if (!scoreIndex.has(row.student_id)) scoreIndex.set(row.student_id, new Set());
    scoreIndex.get(row.student_id)!.add(row.component_id);
  }

  const missing: MissingScore[] = [];
  let fullyScored = 0;

  for (const student of students) {
    const scored = scoreIndex.get(student.student_id) ?? new Set<string>();
    const missingComponents = config.components
      .filter(c => !scored.has(c.id))
      .map(c => c.name);

    if (missingComponents.length === 0) {
      fullyScored++;
    } else {
      missing.push({ ...student, missing_components: missingComponents });
    }
  }

  return { total_students: students.length, fully_scored: fullyScored, missing };
}

/**
 * Batch-upsert result_status for multiple students in one query using unnest.
 * If guardFromStatuses is provided, the DO UPDATE only fires when the existing
 * row's status is in that list — higher statuses are never downgraded accidentally.
 */
export async function batchUpsertStatuses(
  studentIds: string[],
  schoolId: string,
  termId: string,
  newStatus: string,
  updatedBy: string,
  guardFromStatuses?: string[]
): Promise<void> {
  if (studentIds.length === 0) return;

  if (guardFromStatuses?.length) {
    await pool.query(
      `INSERT INTO result_status (student_id, term_id, school_id, status, updated_by)
       SELECT unnest($1::uuid[]), $2, $3, $4::chronixedu_result_status, $5
       ON CONFLICT (student_id, term_id) DO UPDATE
         SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       WHERE result_status.status = ANY($6::chronixedu_result_status[])`,
      [studentIds, termId, schoolId, newStatus, updatedBy, guardFromStatuses]
    );
  } else {
    await pool.query(
      `INSERT INTO result_status (student_id, term_id, school_id, status, updated_by)
       SELECT unnest($1::uuid[]), $2, $3, $4::chronixedu_result_status, $5
       ON CONFLICT (student_id, term_id) DO UPDATE
         SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [studentIds, termId, schoolId, newStatus, updatedBy]
    );
  }
}

/** Subject+teacher assignments for a class — used in submit auth check and dashboard. */
export async function getClassSubjectAssignments(
  classId: string,
  termId: string,
  schoolId: string
): Promise<ClassSubjectAssignment[]> {
  const result = await pool.query<ClassSubjectAssignment>(
    `SELECT ta.class_id, ta.id AS assignment_id, ta.subject_id,
            sub.name AS subject_name, sub.code AS subject_code,
            ta.teacher_id, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name
     FROM teacher_assignments ta
     JOIN subjects sub ON sub.id = ta.subject_id
     JOIN users    u   ON u.id   = ta.teacher_id
     WHERE ta.class_id = $1 AND ta.term_id = $2 AND ta.school_id = $3
     ORDER BY sub.name`,
    [classId, termId, schoolId]
  );
  return result.rows;
}

/** Distinct teachers assigned to a class+term — for return notifications. */
export async function getTeachersForClass(
  classId: string,
  termId: string,
  schoolId: string
): Promise<Array<{ teacher_id: string; teacher_first_name: string; teacher_last_name: string }>> {
  const result = await pool.query<{
    teacher_id: string; teacher_first_name: string; teacher_last_name: string;
  }>(
    `SELECT DISTINCT ta.teacher_id, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name
     FROM teacher_assignments ta
     JOIN users u ON u.id = ta.teacher_id
     WHERE ta.class_id = $1 AND ta.term_id = $2 AND ta.school_id = $3`,
    [classId, termId, schoolId]
  );
  return result.rows;
}

/**
 * Approval dashboard — per-class, per-subject completion breakdown.
 * Uses ~6 DB queries total (bulk fetches) regardless of school size.
 */
export async function getApprovalDashboard(
  schoolId: string,
  termId: string
): Promise<ClassDashboardEntry[]> {
  // 1. Classes that have at least one teacher assignment this term
  const classesRes = await pool.query<{
    class_id: string; class_name: string; class_level: string;
  }>(
    `SELECT DISTINCT c.id AS class_id, c.name AS class_name, c.level AS class_level
     FROM teacher_assignments ta
     JOIN classes c ON c.id = ta.class_id
     WHERE ta.term_id = $1 AND ta.school_id = $2
     ORDER BY c.name`,
    [termId, schoolId]
  );
  const classIds = classesRes.rows.map(c => c.class_id);
  if (classIds.length === 0) return [];

  const termRes = await pool.query<{ session_id: string }>(
    `SELECT session_id FROM terms WHERE id = $1`, [termId]
  );
  const sessionId = termRes.rows[0]?.session_id;
  if (!sessionId) return [];

  // 2. All enrolled students for all these classes, with their result_status
  const studentsRes = await pool.query<{
    class_id: string; student_id: string;
    first_name: string; last_name: string; admission_no: string;
    current_status: string | null;
  }>(
    `SELECT sc.class_id, s.id AS student_id, u.first_name, u.last_name, s.admission_no,
            rs.status AS current_status
     FROM student_classes sc
     JOIN students s ON s.id = sc.student_id
     JOIN users   u ON u.id = s.user_id
     LEFT JOIN result_status rs
       ON rs.student_id = s.id AND rs.term_id = $1 AND rs.school_id = $3
     WHERE sc.class_id = ANY($2::uuid[]) AND sc.session_id = $4`,
    [termId, classIds, schoolId, sessionId]
  );

  // 3. All teacher assignments for these classes
  const assignmentsRes = await pool.query<ClassSubjectAssignment>(
    `SELECT ta.class_id, ta.id AS assignment_id, ta.subject_id,
            sub.name AS subject_name, sub.code AS subject_code,
            ta.teacher_id, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name
     FROM teacher_assignments ta
     JOIN subjects sub ON sub.id = ta.subject_id
     JOIN users    u   ON u.id   = ta.teacher_id
     WHERE ta.class_id = ANY($1::uuid[]) AND ta.term_id = $2 AND ta.school_id = $3
     ORDER BY sub.name`,
    [classIds, termId, schoolId]
  );

  // 4. All scores for all enrolled students this term
  const allStudentIds = [...new Set(studentsRes.rows.map(r => r.student_id))];
  const scoresRes = allStudentIds.length > 0
    ? await pool.query<{ student_id: string; subject_id: string; component_id: string }>(
        `SELECT student_id, subject_id, component_id FROM scores
         WHERE student_id = ANY($1::uuid[]) AND term_id = $2`,
        [allStudentIds, termId]
      )
    : { rows: [] };

  // 5. All assessment configs for this term+school, with their components
  const configsRes = await pool.query<BulkConfig & { id: string }>(
    `SELECT ac.id, ac.subject_id, ac.class_level, ac.is_default,
            json_agg(
              json_build_object('id', comp.id, 'name', comp.name)
              ORDER BY comp.display_order
            ) FILTER (WHERE comp.id IS NOT NULL) AS components
     FROM assessment_configs ac
     LEFT JOIN assessment_components comp ON comp.config_id = ac.id
     WHERE ac.school_id = $1 AND ac.term_id = $2
     GROUP BY ac.id`,
    [schoolId, termId]
  );
  const allConfigs = configsRes.rows;

  // Index: student_id → subject_id → Set<component_id>
  const scoreIndex = new Map<string, Map<string, Set<string>>>();
  for (const row of scoresRes.rows) {
    if (!scoreIndex.has(row.student_id)) scoreIndex.set(row.student_id, new Map());
    const bySub = scoreIndex.get(row.student_id)!;
    if (!bySub.has(row.subject_id)) bySub.set(row.subject_id, new Set());
    bySub.get(row.subject_id)!.add(row.component_id);
  }

  // Index students and assignments by class_id
  const studentsByClass = new Map<string, typeof studentsRes.rows>();
  for (const row of studentsRes.rows) {
    if (!studentsByClass.has(row.class_id)) studentsByClass.set(row.class_id, []);
    studentsByClass.get(row.class_id)!.push(row);
  }
  const assignmentsByClass = new Map<string, ClassSubjectAssignment[]>();
  for (const row of assignmentsRes.rows) {
    if (!assignmentsByClass.has(row.class_id)) assignmentsByClass.set(row.class_id, []);
    assignmentsByClass.get(row.class_id)!.push(row);
  }

  // Build dashboard entries
  return classesRes.rows.map(cls => {
    const students  = studentsByClass.get(cls.class_id)  ?? [];
    const asgns     = assignmentsByClass.get(cls.class_id) ?? [];

    const statusSummary: ClassStatusSummary = { draft: 0, submitted: 0, approved: 0, published: 0 };
    for (const s of students) {
      const key = (s.current_status ?? 'draft') as keyof ClassStatusSummary;
      if (key in statusSummary) statusSummary[key]++;
    }

    const subjectStatuses: SubjectStatusInfo[] = asgns.map(asgn => {
      const config     = resolveConfigFromBulk(allConfigs, cls.class_level, asgn.subject_id);
      const compIds    = config?.components?.map(c => c.id) ?? [];
      let fullyScored  = 0;

      for (const student of students) {
        const subScores = scoreIndex.get(student.student_id)?.get(asgn.subject_id) ?? new Set<string>();
        if (compIds.length > 0 && compIds.every(cId => subScores.has(cId))) fullyScored++;
      }

      const total      = students.length;
      const isComplete = total > 0 && compIds.length > 0 && fullyScored === total;
      return {
        subject_id:            asgn.subject_id,
        subject_name:          asgn.subject_name,
        subject_code:          asgn.subject_code,
        teacher_id:            asgn.teacher_id,
        teacher_name:          `${asgn.teacher_first_name} ${asgn.teacher_last_name}`.trim(),
        total_students:        total,
        fully_scored_students: fullyScored,
        completion_pct:        total > 0 ? Math.round(fullyScored / total * 100) : 0,
        is_complete:           isComplete,
      };
    });

    const allSubjectsComplete = asgns.length > 0 && subjectStatuses.every(s => s.is_complete);
    const n = students.length;
    const canApprove = allSubjectsComplete && n > 0 && statusSummary.submitted === n;
    const canPublish  = n > 0 && statusSummary.approved === n;

    return {
      class_id:    cls.class_id,
      class_name:  cls.class_name,
      class_level: cls.class_level,
      total_students:       n,
      subjects:             subjectStatuses,
      status_summary:       statusSummary,
      all_subjects_complete: allSubjectsComplete,
      can_approve:  canApprove,
      can_publish:  canPublish,
    };
  });
}
