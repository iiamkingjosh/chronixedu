import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LinkedChild {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_no: string;
  photo_url: string | null;
  class_id: string | null;
  class_name: string | null;
  class_level: string | null;
  relationship_type: string;
  is_primary_contact: boolean;
}

// ── Queries ────────────────────────────────────────────────────────────────────

/** All students linked to a parent within a school, with their current class. */
export async function getLinkedChildren(parentId: string, schoolId: string): Promise<LinkedChild[]> {
  const result = await pool.query<LinkedChild>(
    `SELECT s.id AS student_id, u.first_name, u.last_name, s.admission_no, s.photo_url,
            sc.class_id, c.name AS class_name, c.level AS class_level,
            ps.relationship_type, ps.is_primary_contact
     FROM parent_students ps
     JOIN students s ON s.id = ps.student_id
     JOIN users u ON u.id = s.user_id
     LEFT JOIN student_classes sc
       ON sc.student_id = s.id
      AND sc.session_id = (SELECT id FROM academic_sessions WHERE school_id = $2 AND is_current = TRUE)
     LEFT JOIN classes c ON c.id = sc.class_id
     WHERE ps.parent_id = $1 AND s.school_id = $2
     ORDER BY u.first_name, u.last_name`,
    [parentId, schoolId]
  );
  return result.rows;
}

/** Authorization check — is this parent linked to this student? */
export async function isParentLinkedToStudent(parentId: string, studentId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM parent_students WHERE parent_id = $1 AND student_id = $2`,
    [parentId, studentId]
  );
  return result.rows.length > 0;
}

export interface ParentRecipient {
  parent_id: string;
  email: string;
  phone: string | null;
}

/** All parents linked to a student, for notification fan-out. */
export async function getParentsForStudent(studentId: string): Promise<ParentRecipient[]> {
  const result = await pool.query<ParentRecipient>(
    `SELECT u.id AS parent_id, u.email, u.phone
     FROM parent_students ps
     JOIN users u ON u.id = ps.parent_id
     WHERE ps.student_id = $1`,
    [studentId]
  );
  return result.rows;
}
