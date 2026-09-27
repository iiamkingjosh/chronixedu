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

/**
 * One notice by id, scoped to the school.
 *
 * Every write path resolves the row through this before touching it, so tenancy is
 * checked against the target and not only against the caller's token (doctrine 3).
 * `notices` carries `school_id` directly, so unlike `principal_remarks` there is no join
 * to reason about here — the scope is the WHERE clause.
 */
export async function findNoticeById(noticeId: string, schoolId: string): Promise<NoticeRow | null> {
  const result = await pool.query<NoticeRow>(
    `SELECT id, school_id, class_id, title, body, created_by, created_at
     FROM notices WHERE id = $1 AND school_id = $2`,
    [noticeId, schoolId]
  );
  return result.rows[0] ?? null;
}

/**
 * Notices visible to a member of staff.
 *
 * A principal sees every notice in the school. A teacher sees the school-wide ones plus
 * those for the classes passed in — the same set they could post to. Without this the
 * delete route is unreachable from any interface: you cannot remove a notice you have no
 * way to list.
 */
export async function listNoticesForStaff(
  schoolId: string,
  classIds: string[] | null,
  limit = 50
): Promise<NoticeRow[]> {
  if (classIds === null) {
    const result = await pool.query<NoticeRow>(
      `SELECT id, school_id, class_id, title, body, created_by, created_at
       FROM notices WHERE school_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [schoolId, limit]
    );
    return result.rows;
  }
  const result = await pool.query<NoticeRow>(
    `SELECT id, school_id, class_id, title, body, created_by, created_at
     FROM notices
     WHERE school_id = $1 AND (class_id IS NULL OR class_id = ANY($2::uuid[]))
     ORDER BY created_at DESC LIMIT $3`,
    [schoolId, classIds, limit]
  );
  return result.rows;
}

export interface CreateNoticeInput {
  school_id: string;
  class_id: string | null;
  title: string;
  body: string;
  created_by: string;
}

export async function createNotice(input: CreateNoticeInput): Promise<NoticeRow> {
  const result = await pool.query<NoticeRow>(
    `INSERT INTO notices (school_id, class_id, title, body, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, school_id, class_id, title, body, created_by, created_at`,
    [input.school_id, input.class_id, input.title, input.body, input.created_by]
  );
  return result.rows[0];
}

/**
 * Hard delete, scoped to the school.
 *
 * Not a soft delete: the audit row is the record that it happened and `audit_logs` is
 * append-only at the database level, so nothing is lost by removing the row itself. A
 * `deleted_at` column would instead put the burden on every reader forever — and the
 * student read is the one place a missed filter shows a notice that was taken down.
 */
export async function deleteNotice(noticeId: string, schoolId: string): Promise<boolean> {
  const result = await pool.query(`DELETE FROM notices WHERE id = $1 AND school_id = $2`, [noticeId, schoolId]);
  return (result.rowCount ?? 0) > 0;
}
