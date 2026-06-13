import pool from '../client';

export interface StudentReportData {
  student_id:    string;
  first_name:    string;
  last_name:     string;
  admission_no:  string;
  photo_url:     string | null;
  class_id:      string;
  class_name:    string;
  class_level:   string | null;
  term_id:       string;
  term_name:     string;
  session_name:  string;
  next_term_resumption: string | null;
}

export interface ClassTeacherComment {
  comment_text: string;
}

export interface FormTeacher {
  id:            string;
  full_name:     string;
  title:         string | null;
  signature_url: string | null;
}

export interface PrincipalRemark {
  remark_text: string;
}

export interface ExistingReportCard {
  id:           string;
  pdf_url:      string | null;
  is_published: boolean;
  generated_at: string;
}

export async function fetchStudentReportData(
  studentId: string,
  termId: string,
  schoolId: string
): Promise<StudentReportData | null> {
  const result = await pool.query<StudentReportData>(
    `SELECT
       s.id              AS student_id,
       u.first_name,
       u.last_name,
       s.admission_no,
       s.photo_url,
       sc.class_id,
       c.name            AS class_name,
       c.level           AS class_level,
       t.id              AS term_id,
       t.name            AS term_name,
       sess.name         AS session_name,
       (
         SELECT nt.start_date::text
         FROM terms nt
         WHERE nt.session_id = t.session_id
           AND nt.start_date > t.end_date
         ORDER BY nt.start_date ASC
         LIMIT 1
       ) AS next_term_resumption
     FROM students s
     JOIN users u            ON u.id = s.user_id
     JOIN terms t            ON t.id = $2
     JOIN academic_sessions sess ON sess.id = t.session_id
     JOIN student_classes sc ON sc.student_id = s.id
                            AND sc.session_id = sess.id
     JOIN classes c          ON c.id = sc.class_id
     WHERE s.id = $1 AND s.school_id = $3`,
    [studentId, termId, schoolId]
  );
  return result.rows[0] ?? null;
}

export async function fetchClassTeacherComment(
  studentId: string,
  termId: string
): Promise<ClassTeacherComment | null> {
  const result = await pool.query<ClassTeacherComment>(
    `SELECT comment_text
     FROM class_teacher_comments
     WHERE student_id = $1 AND term_id = $2`,
    [studentId, termId]
  );
  return result.rows[0] ?? null;
}

export async function fetchFormTeacher(classId: string): Promise<FormTeacher | null> {
  const result = await pool.query<FormTeacher>(
    `SELECT u.id, (u.first_name || ' ' || u.last_name) AS full_name, u.title, u.signature_url
     FROM classes c
     JOIN users u ON u.id = c.form_teacher_id
     WHERE c.id = $1`,
    [classId]
  );
  return result.rows[0] ?? null;
}

export async function fetchPrincipalRemark(
  studentId: string,
  termId: string
): Promise<PrincipalRemark | null> {
  const result = await pool.query<PrincipalRemark>(
    `SELECT remark_text
     FROM principal_remarks
     WHERE student_id = $1 AND term_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [studentId, termId]
  );
  return result.rows[0] ?? null;
}

export async function upsertReportCard(
  studentId: string,
  termId: string,
  schoolId: string,
  pdfUrl: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO report_cards (student_id, term_id, school_id, pdf_url, generated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (student_id, term_id)
     DO UPDATE SET pdf_url = EXCLUDED.pdf_url, generated_at = NOW()
     RETURNING id`,
    [studentId, termId, schoolId, pdfUrl]
  );
  return result.rows[0].id;
}

export async function getReportCardsForClass(
  classId: string,
  termId: string,
  schoolId: string
): Promise<Array<ExistingReportCard & { student_id: string }>> {
  const result = await pool.query<ExistingReportCard & { student_id: string }>(
    `SELECT rc.id, rc.student_id, rc.pdf_url, rc.is_published, rc.generated_at
     FROM report_cards rc
     JOIN student_classes sc ON sc.student_id = rc.student_id AND sc.class_id = $1
     WHERE rc.term_id = $2 AND rc.school_id = $3`,
    [classId, termId, schoolId]
  );
  return result.rows;
}
