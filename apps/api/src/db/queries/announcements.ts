import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export type AnnouncementTarget = 'all' | 'teacher' | 'parent' | 'student';

export interface AnnouncementRow {
  id: string;
  school_id: string;
  author_id: string;
  title: string;
  body: string;
  target_role: AnnouncementTarget;
  published_at: string;
  author_first_name: string;
  author_last_name: string;
}

const ANNOUNCEMENT_COLUMNS = `
  a.id, a.school_id, a.author_id, a.title, a.body, a.target_role, a.published_at,
  u.first_name AS author_first_name, u.last_name AS author_last_name`;

// ── Create ─────────────────────────────────────────────────────────────────────

export async function createAnnouncement(data: {
  school_id: string;
  author_id: string;
  title: string;
  body: string;
  target_role: AnnouncementTarget;
}): Promise<AnnouncementRow> {
  const result = await pool.query<AnnouncementRow>(
    `WITH inserted AS (
       INSERT INTO announcements (school_id, author_id, title, body, target_role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *
     )
     SELECT ${ANNOUNCEMENT_COLUMNS}
     FROM inserted a JOIN users u ON u.id = a.author_id`,
    [data.school_id, data.author_id, data.title, data.body, data.target_role]
  );
  return result.rows[0];
}

// ── List ───────────────────────────────────────────────────────────────────────

/** Announcements visible to a given role — principals/super_admins see everything. */
export async function listAnnouncementsForRole(schoolId: string, role: string): Promise<AnnouncementRow[]> {
  const seesAll = role === 'principal' || role === 'super_admin';
  const result = await pool.query<AnnouncementRow>(
    `SELECT ${ANNOUNCEMENT_COLUMNS}
     FROM announcements a JOIN users u ON u.id = a.author_id
     WHERE a.school_id = $1 ${seesAll ? '' : "AND (a.target_role = 'all' OR a.target_role::text = $2)"}
     ORDER BY a.published_at DESC`,
    seesAll ? [schoolId] : [schoolId, role]
  );
  return result.rows;
}

// ── Targeted users (for in-app notification fan-out) ─────────────────────────────

export interface TargetUser {
  id: string;
  email: string;
}

export async function getTargetUsers(schoolId: string, targetRole: AnnouncementTarget): Promise<TargetUser[]> {
  const result = await pool.query<TargetUser>(
    `SELECT id, email FROM users
     WHERE school_id = $1 AND is_active = TRUE
       AND ($2 = 'all' OR role::text = $2)`,
    [schoolId, targetRole]
  );
  return result.rows;
}
