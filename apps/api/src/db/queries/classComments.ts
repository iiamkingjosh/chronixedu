import pool from '../client';

export interface FormTeacherClassRow {
  id:     string;
  name:   string;
  level:  string;
  stream: string | null;
}

export interface ClassCommentStudentRow {
  student_id:   string;
  first_name:   string;
  last_name:    string;
  admission_no: string;
  comment_text: string | null;
}

export async function findClassByFormTeacher(teacherId: string, schoolId: string): Promise<FormTeacherClassRow | null> {
  const result = await pool.query<FormTeacherClassRow>(
    `SELECT id, name, level, stream FROM classes WHERE form_teacher_id = $1 AND school_id = $2`,
    [teacherId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function listClassStudentsForComments(
  classId: string,
  termId: string,
  sessionId: string
): Promise<ClassCommentStudentRow[]> {
  const result = await pool.query<ClassCommentStudentRow>(
    `SELECT s.id AS student_id, u.first_name, u.last_name, s.admission_no, ctc.comment_text
     FROM student_classes sc
     JOIN students s ON s.id = sc.student_id
     JOIN users u    ON u.id = s.user_id
     LEFT JOIN class_teacher_comments ctc ON ctc.student_id = s.id AND ctc.term_id = $2
     WHERE sc.class_id = $1 AND sc.session_id = $3
     ORDER BY u.last_name, u.first_name`,
    [classId, termId, sessionId]
  );
  return result.rows;
}

export async function findStudentClassForTerm(studentId: string, sessionId: string): Promise<{ class_id: string } | null> {
  const result = await pool.query<{ class_id: string }>(
    `SELECT class_id FROM student_classes WHERE student_id = $1 AND session_id = $2`,
    [studentId, sessionId]
  );
  return result.rows[0] ?? null;
}

export async function upsertClassTeacherComment(
  studentId: string,
  termId: string,
  teacherId: string,
  commentText: string
): Promise<void> {
  await pool.query(
    `INSERT INTO class_teacher_comments (student_id, term_id, teacher_id, comment_text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (student_id, term_id)
     DO UPDATE SET comment_text = EXCLUDED.comment_text, teacher_id = EXCLUDED.teacher_id, updated_at = NOW()`,
    [studentId, termId, teacherId, commentText]
  );
}
