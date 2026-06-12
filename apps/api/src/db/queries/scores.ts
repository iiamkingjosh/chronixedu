import pool from '../client';
import { resolveAssessmentConfig } from './assessmentConfig';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScoreRow {
  id: string;
  school_id: string;
  student_id: string;
  subject_id: string;
  term_id: string;
  component_id: string;
  score: number;
  entered_by: string | null;
  entered_at: string;
  updated_at: string | null;
}

export interface ComponentInfo {
  id: string;
  config_id: string;
  name: string;
  max_score: number;
  weight_percent: number;
  display_order: number;
}

// ── Validation helpers ─────────────────────────────────────────────────────────

export async function checkTeacherAssigned(
  teacherId: string,
  subjectId: string,
  classId: string,
  termId: string,
  schoolId: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM teacher_assignments
     WHERE teacher_id = $1 AND subject_id = $2 AND class_id = $3 AND term_id = $4 AND school_id = $5`,
    [teacherId, subjectId, classId, termId, schoolId]
  );
  return result.rows.length > 0;
}

export async function getComponentInfo(
  componentId: string,
  schoolId: string
): Promise<ComponentInfo | null> {
  const result = await pool.query<ComponentInfo>(
    `SELECT ac.id, ac.config_id, ac.name, ac.max_score, ac.weight_percent, ac.display_order
     FROM assessment_components ac
     JOIN assessment_configs cfg ON cfg.id = ac.config_id
     WHERE ac.id = $1 AND cfg.school_id = $2`,
    [componentId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function getResultStatus(
  studentId: string,
  termId: string,
  schoolId: string
): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM result_status WHERE student_id = $1 AND term_id = $2 AND school_id = $3`,
    [studentId, termId, schoolId]
  );
  return result.rows[0]?.status ?? null;
}

// Capture existing score before upsert so we can log old_value in audit_logs
export async function getExistingScore(
  studentId: string,
  termId: string,
  componentId: string
): Promise<{ id: string; score: number } | null> {
  const result = await pool.query<{ id: string; score: number }>(
    `SELECT id, score FROM scores WHERE student_id = $1 AND term_id = $2 AND component_id = $3`,
    [studentId, termId, componentId]
  );
  return result.rows[0] ?? null;
}

// ── Single score upsert ────────────────────────────────────────────────────────

export async function upsertScore(
  schoolId: string,
  studentId: string,
  subjectId: string,
  termId: string,
  componentId: string,
  score: number,
  enteredBy: string
): Promise<ScoreRow> {
  const result = await pool.query<ScoreRow>(
    `INSERT INTO scores (school_id, student_id, subject_id, term_id, component_id, score, entered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (student_id, term_id, component_id) DO UPDATE
       SET score = EXCLUDED.score, entered_by = EXCLUDED.entered_by, updated_at = NOW()
     RETURNING id, school_id, student_id, subject_id, term_id, component_id, score,
               entered_by, entered_at, updated_at`,
    [schoolId, studentId, subjectId, termId, componentId, score, enteredBy]
  );
  return result.rows[0];
}

// ── Bulk score upsert (transaction) ───────────────────────────────────────────

export interface BulkEntry {
  student_id: string;
  component_id: string;
  score: number;
}

export interface BulkValidationError {
  index: number;
  student_id: string;
  component_id: string;
  reason: string;
}

export interface BulkUpsertResult {
  saved: ScoreRow[];
  errors: BulkValidationError[];
}

export async function bulkUpsertScores(
  schoolId: string,
  subjectId: string,
  termId: string,
  enteredBy: string,
  entries: BulkEntry[],
  componentMap: Map<string, ComponentInfo>,
  lockedStudents: Set<string>
): Promise<BulkUpsertResult> {
  const client = await pool.connect();
  const saved: ScoreRow[] = [];
  const errors: BulkValidationError[] = [];

  // Validate all entries before touching the DB
  for (let i = 0; i < entries.length; i++) {
    const { student_id, component_id, score } = entries[i];
    const comp = componentMap.get(component_id);

    if (!comp) {
      errors.push({ index: i, student_id, component_id, reason: `Component ${component_id} not found or not in this school` });
      continue;
    }
    if (score > Number(comp.max_score)) {
      errors.push({ index: i, student_id, component_id, reason: `Score ${score} exceeds max_score ${comp.max_score} for component "${comp.name}"` });
      continue;
    }
    if (lockedStudents.has(student_id)) {
      errors.push({ index: i, student_id, component_id, reason: `Result for student ${student_id} is approved or published and cannot be changed` });
    }
  }

  if (errors.length > 0) {
    return { saved: [], errors };
  }

  try {
    await client.query('BEGIN');

    for (const { student_id, component_id, score } of entries) {
      const row = await client.query<ScoreRow>(
        `INSERT INTO scores (school_id, student_id, subject_id, term_id, component_id, score, entered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (student_id, term_id, component_id) DO UPDATE
           SET score = EXCLUDED.score, entered_by = EXCLUDED.entered_by, updated_at = NOW()
         RETURNING id, school_id, student_id, subject_id, term_id, component_id, score,
                   entered_by, entered_at, updated_at`,
        [schoolId, student_id, subjectId, termId, component_id, score, enteredBy]
      );
      saved.push(row.rows[0]);
    }

    await client.query('COMMIT');
    return { saved, errors: [] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Class sheet ────────────────────────────────────────────────────────────────

export interface SheetStudent {
  student_id: string;
  admission_no: string;
  first_name: string;
  last_name: string;
  scores: Record<string, { score_id: string; score: number } | null>;
}

export interface ClassSheetResult {
  class_info:  { id: string; name: string; level: string; stream: string | null };
  subject_info: { id: string; name: string; code: string };
  term_info:   { id: string; name: string };
  components:  ComponentInfo[];
  students:    SheetStudent[];
}

export async function getClassSheet(
  schoolId: string,
  classId: string,
  subjectId: string,
  termId: string
): Promise<ClassSheetResult | null> {
  // Fetch supporting metadata in parallel
  const [classResult, subjectResult, termResult] = await Promise.all([
    pool.query<{ id: string; name: string; level: string; stream: string | null }>(
      `SELECT id, name, level, stream FROM classes WHERE id = $1 AND school_id = $2`,
      [classId, schoolId]
    ),
    pool.query<{ id: string; name: string; code: string }>(
      `SELECT id, name, code FROM subjects WHERE id = $1 AND school_id = $2`,
      [subjectId, schoolId]
    ),
    pool.query<{ id: string; name: string; session_id: string }>(
      `SELECT id, name, session_id FROM terms WHERE id = $1 AND school_id = $2`,
      [termId, schoolId]
    ),
  ]);

  if (!classResult.rows[0] || !subjectResult.rows[0] || !termResult.rows[0]) return null;

  const cls     = classResult.rows[0];
  const subject = subjectResult.rows[0];
  const term    = termResult.rows[0];

  // Resolve assessment config to get components for this class+subject+term
  const config = await resolveAssessmentConfig(schoolId, classId, subjectId, termId);
  const components: ComponentInfo[] = config?.components ?? [];

  // Students enrolled in this class for the term's session
  const studentsResult = await pool.query<{
    student_id: string; admission_no: string; first_name: string; last_name: string;
  }>(
    `SELECT s.id AS student_id, s.admission_no, u.first_name, u.last_name
     FROM student_classes sc
     JOIN students s ON s.id = sc.student_id
     JOIN users u ON u.id = s.user_id
     WHERE sc.class_id = $1 AND sc.session_id = $2
     ORDER BY u.last_name, u.first_name`,
    [classId, term.session_id]
  );

  const studentIds = studentsResult.rows.map(r => r.student_id);

  // All existing scores for these students this subject+term
  const scoresResult = studentIds.length > 0
    ? await pool.query<{ id: string; student_id: string; component_id: string; score: number }>(
        `SELECT id, student_id, component_id, score
         FROM scores
         WHERE subject_id = $1 AND term_id = $2 AND student_id = ANY($3::uuid[])`,
        [subjectId, termId, studentIds]
      )
    : { rows: [] };

  // Index scores by student_id → component_id
  const scoreIndex = new Map<string, Map<string, { score_id: string; score: number }>>();
  for (const row of scoresResult.rows) {
    if (!scoreIndex.has(row.student_id)) scoreIndex.set(row.student_id, new Map());
    scoreIndex.get(row.student_id)!.set(row.component_id, { score_id: row.id, score: Number(row.score) });
  }

  // Build grid
  const students: SheetStudent[] = studentsResult.rows.map(st => {
    const scoresByComponent: Record<string, { score_id: string; score: number } | null> = {};
    for (const comp of components) {
      scoresByComponent[comp.id] = scoreIndex.get(st.student_id)?.get(comp.id) ?? null;
    }
    return { ...st, scores: scoresByComponent };
  });

  return {
    class_info:   cls,
    subject_info: subject,
    term_info:    { id: term.id, name: term.name },
    components,
    students,
  };
}

// ── My pending ─────────────────────────────────────────────────────────────────

export interface PendingAssignment {
  assignment_id: string;
  class_id: string;
  class_name: string;
  subject_id: string;
  subject_name: string;
  subject_code: string;
  missing_student_count: number;
}

export async function getMyPendingAssignments(
  teacherId: string,
  schoolId: string,
  termId: string
): Promise<PendingAssignment[]> {
  // Returns assignments for this teacher+term where at least one enrolled student
  // has zero score entries for that subject+term
  const result = await pool.query<PendingAssignment>(
    `SELECT
       ta.id  AS assignment_id,
       ta.class_id,
       c.name AS class_name,
       ta.subject_id,
       s.name AS subject_name,
       s.code AS subject_code,
       (
         SELECT COUNT(*)::int
         FROM student_classes sc
         WHERE sc.class_id = ta.class_id
           AND sc.session_id = (SELECT session_id FROM terms WHERE id = ta.term_id)
           AND NOT EXISTS (
             SELECT 1 FROM scores
             WHERE student_id = sc.student_id
               AND subject_id = ta.subject_id
               AND term_id    = ta.term_id
           )
       ) AS missing_student_count
     FROM teacher_assignments ta
     JOIN classes  c ON c.id = ta.class_id
     JOIN subjects s ON s.id = ta.subject_id
     WHERE ta.teacher_id = $1 AND ta.school_id = $2 AND ta.term_id = $3
       AND EXISTS (
         SELECT 1 FROM student_classes sc2
         WHERE sc2.class_id = ta.class_id
           AND sc2.session_id = (SELECT session_id FROM terms WHERE id = ta.term_id)
           AND NOT EXISTS (
             SELECT 1 FROM scores
             WHERE student_id = sc2.student_id
               AND subject_id = ta.subject_id
               AND term_id    = ta.term_id
           )
       )
     ORDER BY c.name, s.name`,
    [teacherId, schoolId, termId]
  );
  return result.rows;
}
