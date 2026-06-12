import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AssignmentRow {
  id: string;
  school_id: string;
  class_id: string;
  subject_id: string;
  teacher_id: string;
  title: string;
  description: string | null;
  due_date: string;
  attachment_url: string | null;
  created_at: string;
}

export interface SubmissionRow {
  id: string;
  assignment_id: string;
  student_id: string;
  submitted_at: string;
  file_url: string;
  grade: number | null;
  feedback: string | null;
  graded_by: string | null;
}

export interface TeacherAssignmentListRow extends AssignmentRow {
  class_name: string;
  subject_name: string;
  students_total: number;
  students_submitted: number;
  students_graded: number;
}

export interface StudentAssignmentListRow extends AssignmentRow {
  subject_name: string;
  submission: {
    id: string;
    submitted_at: string;
    file_url: string;
    grade: number | null;
    feedback: string | null;
  } | null;
}

export interface SubmissionGridRow {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  submission: SubmissionRow | null;
}

// ── Queries ────────────────────────────────────────────────────────────────────

export async function createAssignment(data: {
  school_id: string;
  class_id: string;
  subject_id: string;
  teacher_id: string;
  title: string;
  description: string | null;
  due_date: string;
}): Promise<AssignmentRow> {
  const result = await pool.query<AssignmentRow>(
    `INSERT INTO assignments (school_id, class_id, subject_id, teacher_id, title, description, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [data.school_id, data.class_id, data.subject_id, data.teacher_id, data.title, data.description, data.due_date]
  );
  return result.rows[0];
}

export async function updateAssignmentAttachment(
  id: string,
  schoolId: string,
  attachmentUrl: string
): Promise<AssignmentRow | null> {
  const result = await pool.query<AssignmentRow>(
    `UPDATE assignments SET attachment_url = $1 WHERE id = $2 AND school_id = $3 RETURNING *`,
    [attachmentUrl, id, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function findAssignmentById(id: string, schoolId: string): Promise<AssignmentRow | null> {
  const result = await pool.query<AssignmentRow>(
    `SELECT * FROM assignments WHERE id = $1 AND school_id = $2`,
    [id, schoolId]
  );
  return result.rows[0] ?? null;
}

/** Assignments created by a teacher, with submission/grading progress per assignment. */
export async function listAssignmentsForTeacher(
  teacherId: string,
  schoolId: string
): Promise<TeacherAssignmentListRow[]> {
  const result = await pool.query<TeacherAssignmentListRow>(
    `SELECT
       a.*,
       c.name AS class_name,
       sub.name AS subject_name,
       COUNT(DISTINCT stc.student_id)::int AS students_total,
       COUNT(DISTINCT s.student_id)::int AS students_submitted,
       COUNT(DISTINCT s.student_id) FILTER (WHERE s.grade IS NOT NULL)::int AS students_graded
     FROM assignments a
     JOIN classes c ON c.id = a.class_id
     JOIN subjects sub ON sub.id = a.subject_id
     LEFT JOIN student_classes stc ON stc.class_id = a.class_id
     LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.student_id = stc.student_id
     WHERE a.teacher_id = $1 AND a.school_id = $2
     GROUP BY a.id, c.name, sub.name
     ORDER BY a.due_date DESC`,
    [teacherId, schoolId]
  );
  return result.rows;
}

/** All assignments for a school, with submission/grading progress per assignment — used for principal/admin views. */
export async function listAssignmentsForSchool(schoolId: string): Promise<TeacherAssignmentListRow[]> {
  const result = await pool.query<TeacherAssignmentListRow>(
    `SELECT
       a.*,
       c.name AS class_name,
       sub.name AS subject_name,
       COUNT(DISTINCT stc.student_id)::int AS students_total,
       COUNT(DISTINCT s.student_id)::int AS students_submitted,
       COUNT(DISTINCT s.student_id) FILTER (WHERE s.grade IS NOT NULL)::int AS students_graded
     FROM assignments a
     JOIN classes c ON c.id = a.class_id
     JOIN subjects sub ON sub.id = a.subject_id
     LEFT JOIN student_classes stc ON stc.class_id = a.class_id
     LEFT JOIN assignment_submissions s ON s.assignment_id = a.id AND s.student_id = stc.student_id
     WHERE a.school_id = $1
     GROUP BY a.id, c.name, sub.name
     ORDER BY a.due_date DESC`,
    [schoolId]
  );
  return result.rows;
}

/** Assignments for a student's class, including the student's own submission (if any). */
export async function listAssignmentsForStudent(
  schoolId: string,
  classId: string,
  studentId: string
): Promise<StudentAssignmentListRow[]> {
  const result = await pool.query<{
    id: string;
    school_id: string;
    class_id: string;
    subject_id: string;
    teacher_id: string;
    title: string;
    description: string | null;
    due_date: string;
    attachment_url: string | null;
    created_at: string;
    subject_name: string;
    submission_id: string | null;
    submitted_at: string | null;
    file_url: string | null;
    grade: string | null;
    feedback: string | null;
  }>(
    `SELECT
       a.*,
       sub.name AS subject_name,
       subm.id AS submission_id,
       subm.submitted_at,
       subm.file_url,
       subm.grade,
       subm.feedback
     FROM assignments a
     JOIN subjects sub ON sub.id = a.subject_id
     LEFT JOIN assignment_submissions subm ON subm.assignment_id = a.id AND subm.student_id = $3
     WHERE a.school_id = $1 AND a.class_id = $2
     ORDER BY a.due_date DESC`,
    [schoolId, classId, studentId]
  );

  return result.rows.map(row => ({
    id: row.id,
    school_id: row.school_id,
    class_id: row.class_id,
    subject_id: row.subject_id,
    teacher_id: row.teacher_id,
    title: row.title,
    description: row.description,
    due_date: row.due_date,
    attachment_url: row.attachment_url,
    created_at: row.created_at,
    subject_name: row.subject_name,
    submission: row.submission_id
      ? {
          id: row.submission_id,
          submitted_at: row.submitted_at as string,
          file_url: row.file_url as string,
          grade: row.grade !== null ? Number(row.grade) : null,
          feedback: row.feedback,
        }
      : null,
  }));
}

/** All students in a class with their submission (if any) for one assignment — used for the grading grid. */
export async function listSubmissionsForAssignment(
  assignmentId: string,
  classId: string
): Promise<SubmissionGridRow[]> {
  const result = await pool.query<{
    student_id: string;
    first_name: string;
    last_name: string;
    admission_no: string;
    submission_id: string | null;
    submitted_at: string | null;
    file_url: string | null;
    grade: string | null;
    feedback: string | null;
    graded_by: string | null;
  }>(
    `SELECT
       s.id AS student_id, u.first_name, u.last_name, s.admission_no,
       subm.id AS submission_id, subm.submitted_at, subm.file_url, subm.grade, subm.feedback, subm.graded_by
     FROM students s
     JOIN users u ON u.id = s.user_id
     JOIN student_classes stc ON stc.student_id = s.id AND stc.class_id = $2
     LEFT JOIN assignment_submissions subm ON subm.assignment_id = $1 AND subm.student_id = s.id
     GROUP BY s.id, u.first_name, u.last_name, s.admission_no,
              subm.id, subm.submitted_at, subm.file_url, subm.grade, subm.feedback, subm.graded_by
     ORDER BY u.last_name, u.first_name`,
    [assignmentId, classId]
  );

  return result.rows.map(row => ({
    student_id: row.student_id,
    first_name: row.first_name,
    last_name: row.last_name,
    admission_no: row.admission_no,
    submission: row.submission_id
      ? {
          id: row.submission_id,
          assignment_id: assignmentId,
          student_id: row.student_id,
          submitted_at: row.submitted_at as string,
          file_url: row.file_url as string,
          grade: row.grade !== null ? Number(row.grade) : null,
          feedback: row.feedback,
          graded_by: row.graded_by,
        }
      : null,
  }));
}

/** Insert a submission, or replace the previous one (resubmission clears any prior grade/feedback). */
export async function upsertSubmission(
  assignmentId: string,
  studentId: string,
  fileUrl: string
): Promise<SubmissionRow> {
  const result = await pool.query<{
    id: string;
    assignment_id: string;
    student_id: string;
    submitted_at: string;
    file_url: string;
    grade: string | null;
    feedback: string | null;
    graded_by: string | null;
  }>(
    `INSERT INTO assignment_submissions (assignment_id, student_id, file_url, submitted_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (assignment_id, student_id)
     DO UPDATE SET file_url = EXCLUDED.file_url, submitted_at = NOW(), grade = NULL, feedback = NULL, graded_by = NULL
     RETURNING *`,
    [assignmentId, studentId, fileUrl]
  );
  const row = result.rows[0];
  return { ...row, grade: row.grade !== null ? Number(row.grade) : null };
}

/** Set grade + feedback on an existing submission. Returns null if the student hasn't submitted. */
export async function gradeSubmission(
  assignmentId: string,
  studentId: string,
  grade: number | null,
  feedback: string | null,
  gradedBy: string
): Promise<SubmissionRow | null> {
  const result = await pool.query<{
    id: string;
    assignment_id: string;
    student_id: string;
    submitted_at: string;
    file_url: string;
    grade: string | null;
    feedback: string | null;
    graded_by: string | null;
  }>(
    `UPDATE assignment_submissions
     SET grade = $3, feedback = $4, graded_by = $5
     WHERE assignment_id = $1 AND student_id = $2
     RETURNING *`,
    [assignmentId, studentId, grade, feedback, gradedBy]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, grade: row.grade !== null ? Number(row.grade) : null };
}
