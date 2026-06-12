import pool from '../client';

// ── Classes ────────────────────────────────────────────────────────────────────

export interface ClassRow {
  id: string;
  school_id: string;
  name: string;
  level: string;
  stream: string | null;
}

export async function findClassByName(schoolId: string, name: string): Promise<ClassRow | null> {
  const result = await pool.query<ClassRow>(
    `SELECT id, school_id, name, level, stream FROM classes WHERE school_id = $1 AND name = $2`,
    [schoolId, name]
  );
  return result.rows[0] ?? null;
}

export async function insertClass(
  schoolId: string,
  name: string,
  level: string,
  stream: string | null
): Promise<ClassRow> {
  const result = await pool.query<ClassRow>(
    `INSERT INTO classes (school_id, name, level, stream)
     VALUES ($1, $2, $3, $4)
     RETURNING id, school_id, name, level, stream`,
    [schoolId, name, level, stream ?? null]
  );
  return result.rows[0];
}

export async function updateClass(
  classId: string,
  schoolId: string,
  data: { name: string; level: string; stream: string | null }
): Promise<ClassRow> {
  const result = await pool.query<ClassRow>(
    `UPDATE classes SET name = $1, level = $2, stream = $3
     WHERE id = $4 AND school_id = $5
     RETURNING id, school_id, name, level, stream`,
    [data.name, data.level, data.stream, classId, schoolId]
  );
  return result.rows[0];
}

export async function listClasses(schoolId: string): Promise<ClassRow[]> {
  const result = await pool.query<ClassRow>(
    `SELECT id, school_id, name, level, stream
     FROM classes
     WHERE school_id = $1
     ORDER BY level, name`,
    [schoolId]
  );
  return result.rows;
}

// ── Subjects ───────────────────────────────────────────────────────────────────

export interface SubjectRow {
  id: string;
  school_id: string;
  name: string;
  code: string;
  is_active: boolean;
}

export async function findSubjectByCode(schoolId: string, code: string): Promise<SubjectRow | null> {
  const result = await pool.query<SubjectRow>(
    `SELECT id, school_id, name, code, is_active FROM subjects WHERE school_id = $1 AND code = $2`,
    [schoolId, code]
  );
  return result.rows[0] ?? null;
}

export async function insertSubject(
  schoolId: string,
  name: string,
  code: string
): Promise<SubjectRow> {
  const result = await pool.query<SubjectRow>(
    `INSERT INTO subjects (school_id, name, code)
     VALUES ($1, $2, $3)
     RETURNING id, school_id, name, code, is_active`,
    [schoolId, name, code]
  );
  return result.rows[0];
}

export async function updateSubject(
  subjectId: string,
  schoolId: string,
  data: { name: string; code: string }
): Promise<SubjectRow> {
  const result = await pool.query<SubjectRow>(
    `UPDATE subjects SET name = $1, code = $2
     WHERE id = $3 AND school_id = $4
     RETURNING id, school_id, name, code, is_active`,
    [data.name, data.code, subjectId, schoolId]
  );
  return result.rows[0];
}

export async function listActiveSubjects(schoolId: string): Promise<SubjectRow[]> {
  const result = await pool.query<SubjectRow>(
    `SELECT id, school_id, name, code, is_active
     FROM subjects
     WHERE school_id = $1 AND is_active = TRUE
     ORDER BY name`,
    [schoolId]
  );
  return result.rows;
}

// ── Current term helper ────────────────────────────────────────────────────────

export interface ActiveTermRow {
  id: string;
  name: string;
  session_id: string;
}

export async function getActiveTerm(schoolId: string): Promise<ActiveTermRow | null> {
  const result = await pool.query<ActiveTermRow>(
    `SELECT t.id, t.name, t.session_id
     FROM terms t
     JOIN academic_sessions s ON s.id = t.session_id
     WHERE t.school_id = $1 AND t.is_current = TRUE AND s.is_current = TRUE`,
    [schoolId]
  );
  return result.rows[0] ?? null;
}

// ── Teacher assignments ────────────────────────────────────────────────────────

export interface AssignmentRow {
  id: string;
  teacher_id: string;
  class_id: string;
  subject_id: string;
  term_id: string;
  school_id: string;
}

export interface AssignmentDetail extends AssignmentRow {
  class_name: string;
  class_level: string;
  class_stream: string | null;
  subject_name: string;
  subject_code: string;
}

export interface TeacherAssignmentsResult {
  teacher_mode: string;
  assignments: AssignmentDetail[];
}

export async function findDuplicateAssignment(
  teacherId: string,
  classId: string,
  subjectId: string,
  termId: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM teacher_assignments
     WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3 AND term_id = $4`,
    [teacherId, classId, subjectId, termId]
  );
  return result.rows.length > 0;
}

export async function insertTeacherAssignment(
  teacherId: string,
  classId: string,
  subjectId: string,
  termId: string,
  schoolId: string
): Promise<AssignmentRow> {
  const result = await pool.query<AssignmentRow>(
    `INSERT INTO teacher_assignments (teacher_id, class_id, subject_id, term_id, school_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, teacher_id, class_id, subject_id, term_id, school_id`,
    [teacherId, classId, subjectId, termId, schoolId]
  );
  return result.rows[0];
}

export async function listTeacherAssignments(
  teacherId: string,
  schoolId: string,
  termId: string
): Promise<TeacherAssignmentsResult> {
  const [userResult, assignResult] = await Promise.all([
    pool.query<{ teacher_mode: string }>(
      `SELECT teacher_mode FROM users WHERE id = $1 AND school_id = $2`,
      [teacherId, schoolId]
    ),
    pool.query<AssignmentDetail>(
      `SELECT
         ta.id, ta.teacher_id, ta.class_id, ta.subject_id, ta.term_id, ta.school_id,
         c.name   AS class_name,
         c.level  AS class_level,
         c.stream AS class_stream,
         s.name   AS subject_name,
         s.code   AS subject_code
       FROM teacher_assignments ta
       JOIN classes  c ON c.id = ta.class_id
       JOIN subjects s ON s.id = ta.subject_id
       WHERE ta.teacher_id = $1 AND ta.school_id = $2 AND ta.term_id = $3
       ORDER BY c.level, c.name, s.name`,
      [teacherId, schoolId, termId]
    ),
  ]);

  return {
    teacher_mode: userResult.rows[0]?.teacher_mode ?? 'subject',
    assignments: assignResult.rows,
  };
}

export async function findAssignmentById(id: string, schoolId: string): Promise<AssignmentRow | null> {
  const result = await pool.query<AssignmentRow>(
    `SELECT id, teacher_id, class_id, subject_id, term_id, school_id
     FROM teacher_assignments
     WHERE id = $1 AND school_id = $2`,
    [id, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function scoresExistForAssignment(
  subjectId: string,
  classId: string,
  termId: string
): Promise<boolean> {
  // Scores don't carry class_id directly — the link is student_id → student_classes → class_id
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM scores sc
       WHERE sc.subject_id = $1
         AND sc.term_id    = $2
         AND EXISTS (
           SELECT 1 FROM student_classes stc
           WHERE stc.student_id = sc.student_id
             AND stc.class_id   = $3
         )
     ) AS exists`,
    [subjectId, termId, classId]
  );
  return result.rows[0].exists;
}

export async function deleteTeacherAssignment(id: string, schoolId: string): Promise<void> {
  await pool.query(
    `DELETE FROM teacher_assignments WHERE id = $1 AND school_id = $2`,
    [id, schoolId]
  );
}

// ── Class delete ───────────────────────────────────────────────────────────────

export async function findClassById(classId: string, schoolId: string): Promise<ClassRow | null> {
  const result = await pool.query<ClassRow>(
    `SELECT id, school_id, name, level, stream FROM classes WHERE id = $1 AND school_id = $2`,
    [classId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function classHasReferences(classId: string, schoolId: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM student_classes WHERE class_id = $1
       UNION ALL
       SELECT 1 FROM teacher_assignments WHERE class_id = $1 AND school_id = $2
     ) AS exists`,
    [classId, schoolId]
  );
  return result.rows[0].exists;
}

export async function deleteClass(classId: string, schoolId: string): Promise<void> {
  await pool.query(
    `DELETE FROM classes WHERE id = $1 AND school_id = $2`,
    [classId, schoolId]
  );
}

// ── Subject delete ─────────────────────────────────────────────────────────────

export async function findSubjectById(subjectId: string, schoolId: string): Promise<SubjectRow | null> {
  const result = await pool.query<SubjectRow>(
    `SELECT id, school_id, name, code, is_active FROM subjects WHERE id = $1 AND school_id = $2`,
    [subjectId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function subjectHasReferences(subjectId: string, schoolId: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM teacher_assignments WHERE subject_id = $1 AND school_id = $2
       UNION ALL
       SELECT 1 FROM scores WHERE subject_id = $1 AND school_id = $2
       UNION ALL
       SELECT 1 FROM assessment_configs WHERE subject_id = $1 AND school_id = $2
     ) AS exists`,
    [subjectId, schoolId]
  );
  return result.rows[0].exists;
}

export async function deleteSubject(subjectId: string, schoolId: string): Promise<void> {
  await pool.query(
    `DELETE FROM subjects WHERE id = $1 AND school_id = $2`,
    [subjectId, schoolId]
  );
}
