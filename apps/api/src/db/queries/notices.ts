import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface NoticeRow {
  id: string;
  school_id: string;
  /** Never null: migration 043 made the column NOT NULL. Notices are class-scoped. */
  class_id: string;
  title: string;
  body: string;
  created_by: string;
  created_at: string;
}

// ── Queries ────────────────────────────────────────────────────────────────────

/**
 * Notices for a class.
 *
 * This used to read `(class_id IS NULL OR class_id = $2)`, where NULL meant school-wide.
 * Migration 043 made `class_id` NOT NULL and moved school-wide to `announcements`, where
 * the notification and email fan-out lives — so the NULL branch is gone. Leaving it would
 * have kept a case in the reader that nothing can write, which is the same defect as a
 * writer nothing can read, entered from the other end.
 *
 * A student with no class enrolment gets an empty list rather than a query that relies on
 * `class_id = NULL` never matching. The behaviour is the same; saying it is not.
 */
export async function getNoticesForClass(
  schoolId: string,
  classId: string | null,
  limit = 20
): Promise<NoticeRow[]> {
  if (classId === null) return [];
  const result = await pool.query<NoticeRow>(
    `SELECT id, school_id, class_id, title, body, created_by, created_at
     FROM notices
     WHERE school_id = $1 AND class_id = $2
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
 * A principal sees every notice in the school; a teacher sees exactly the classes passed
 * in, which is the same set they may post to. Without this the delete route is
 * unreachable from any interface: you cannot remove a notice you have no way to list.
 */
export interface StaffNoticeRow extends NoticeRow {
  class_name: string;
  author_name: string;
}

// The class name and author come from the same query rather than a second round trip:
// a list of notices identified only by two UUIDs is not a list anyone can act on.
const STAFF_SELECT = `
  SELECT n.id, n.school_id, n.class_id, n.title, n.body, n.created_by, n.created_at,
         c.name AS class_name,
         TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS author_name
    FROM notices n
    JOIN classes c ON c.id = n.class_id
    JOIN users   u ON u.id = n.created_by`;

export async function listNoticesForStaff(
  schoolId: string,
  classIds: string[] | null,
  limit = 50
): Promise<StaffNoticeRow[]> {
  if (classIds === null) {
    const result = await pool.query<StaffNoticeRow>(
      `${STAFF_SELECT} WHERE n.school_id = $1 ORDER BY n.created_at DESC LIMIT $2`,
      [schoolId, limit]
    );
    return result.rows;
  }
  if (classIds.length === 0) return [];
  const result = await pool.query<StaffNoticeRow>(
    `${STAFF_SELECT}
      WHERE n.school_id = $1 AND n.class_id = ANY($2::uuid[])
      ORDER BY n.created_at DESC LIMIT $3`,
    [schoolId, classIds, limit]
  );
  return result.rows;
}

export interface CreateNoticeInput {
  school_id: string;
  class_id: string;
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
