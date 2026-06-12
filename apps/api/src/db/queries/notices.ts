import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface NoticeRow {
  id: string;
  school_id: string;
  class_id: string | null;
  title: string;
  body: string;
  created_by: string;
  created_at: string;
}

// ── Queries ────────────────────────────────────────────────────────────────────

/** Notices for a class, plus any school-wide notices (class_id IS NULL). */
export async function getNoticesForClass(
  schoolId: string,
  classId: string | null,
  limit = 20
): Promise<NoticeRow[]> {
  const result = await pool.query<NoticeRow>(
    `SELECT id, school_id, class_id, title, body, created_by, created_at
     FROM notices
     WHERE school_id = $1 AND (class_id IS NULL OR class_id = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [schoolId, classId, limit]
  );
  return result.rows;
}
