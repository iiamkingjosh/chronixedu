import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  school_id: string;
  sender_id: string;
  recipient_id: string;
  subject: string | null;
  body: string;
  sent_at: string;
  is_read: boolean;
  thread_id: string;
}

export interface MessageContact {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  email: string;
}

export interface InboxThreadRow {
  thread_id: string;
  last_message_id: string;
  subject: string | null;
  body: string;
  sent_at: string;
  is_read: boolean;
  sender_id: string;
  other_user_id: string;
  other_first_name: string;
  other_last_name: string;
  other_role: string;
  unread_count: number;
}

export interface ThreadMessageRow {
  id: string;
  thread_id: string;
  subject: string | null;
  body: string;
  sent_at: string;
  is_read: boolean;
  sender_id: string;
  recipient_id: string;
  sender_first_name: string;
  sender_last_name: string;
  sender_role: string;
}

// ── Contacts (also used to enforce role-pair rules for POST /messages) ──────────

const CURRENT_SESSION = `(SELECT id FROM academic_sessions WHERE school_id = $2 AND is_current = TRUE)`;

const CONTACT_QUERIES: Record<string, string> = {
  // Parent: teachers of their linked children's current classes, plus any principal.
  parent: `
    WITH contacts AS (
      SELECT DISTINCT u.id, u.first_name, u.last_name, u.role, u.email
      FROM parent_students ps
      JOIN students s ON s.id = ps.student_id
      JOIN student_classes sc ON sc.student_id = s.id AND sc.session_id = ${CURRENT_SESSION}
      JOIN teacher_assignments ta ON ta.class_id = sc.class_id AND ta.school_id = $2
      JOIN users u ON u.id = ta.teacher_id
      WHERE ps.parent_id = $1
      UNION
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM users u WHERE u.school_id = $2 AND u.role = 'principal'
    )
    SELECT * FROM contacts ORDER BY first_name, last_name`,

  // Teacher: parents of students they teach, any principal, and other teachers.
  teacher: `
    WITH contacts AS (
      SELECT DISTINCT u.id, u.first_name, u.last_name, u.role, u.email
      FROM teacher_assignments ta
      JOIN student_classes sc ON sc.class_id = ta.class_id
      JOIN parent_students ps ON ps.student_id = sc.student_id
      JOIN users u ON u.id = ps.parent_id
      WHERE ta.teacher_id = $1 AND ta.school_id = $2
      UNION
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM users u WHERE u.school_id = $2 AND u.role = 'principal'
      UNION
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM users u WHERE u.school_id = $2 AND u.role = 'teacher' AND u.id != $1
    )
    SELECT * FROM contacts ORDER BY first_name, last_name`,

  // Student: teachers of their current class, plus any principal.
  student: `
    WITH contacts AS (
      SELECT DISTINCT u.id, u.first_name, u.last_name, u.role, u.email
      FROM students s
      JOIN student_classes sc ON sc.student_id = s.id AND sc.session_id = ${CURRENT_SESSION}
      JOIN teacher_assignments ta ON ta.class_id = sc.class_id AND ta.school_id = $2
      JOIN users u ON u.id = ta.teacher_id
      WHERE s.user_id = $1
      UNION
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM users u WHERE u.school_id = $2 AND u.role = 'principal'
    )
    SELECT * FROM contacts ORDER BY first_name, last_name`,

  // Principal / super_admin: anyone else in the school.
  principal: `
    SELECT id, first_name, last_name, role, email
    FROM users WHERE school_id = $2 AND id != $1 AND is_active = TRUE
    ORDER BY role, first_name, last_name`,
};
CONTACT_QUERIES.super_admin = CONTACT_QUERIES.principal;

/** Valid messaging contacts for a user, per role-pair rules — used for the recipient picker and to validate POST /messages. */
export async function getMessageContacts(userId: string, role: string, schoolId: string): Promise<MessageContact[]> {
  const query = CONTACT_QUERIES[role];
  if (!query) return [];
  const result = await pool.query<MessageContact>(query, [userId, schoolId]);
  return result.rows;
}

// ── Create / read ─────────────────────────────────────────────────────────────

export async function createMessage(data: {
  school_id: string;
  sender_id: string;
  recipient_id: string;
  subject?: string | null;
  body: string;
  thread_id?: string;
}): Promise<MessageRow> {
  const result = await pool.query<MessageRow>(
    `INSERT INTO messages (school_id, sender_id, recipient_id, subject, body, thread_id)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, gen_random_uuid()))
     RETURNING id, school_id, sender_id, recipient_id, subject, body, sent_at, is_read, thread_id`,
    [data.school_id, data.sender_id, data.recipient_id, data.subject ?? null, data.body, data.thread_id ?? null]
  );
  return result.rows[0];
}

export async function isThreadParticipant(threadId: string, userId: string, schoolId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM messages WHERE thread_id = $1 AND school_id = $2 AND (sender_id = $3 OR recipient_id = $3) LIMIT 1`,
    [threadId, schoolId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Inbox — latest message per thread, with unread counts, newest first. */
export async function getInbox(userId: string, schoolId: string): Promise<InboxThreadRow[]> {
  const result = await pool.query<Omit<InboxThreadRow, 'unread_count'>>(
    `SELECT DISTINCT ON (m.thread_id)
       m.thread_id, m.id AS last_message_id, m.subject, m.body, m.sent_at, m.is_read, m.sender_id,
       CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS other_user_id,
       ou.first_name AS other_first_name, ou.last_name AS other_last_name, ou.role AS other_role
     FROM messages m
     JOIN users ou ON ou.id = CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END
     WHERE m.school_id = $2 AND (m.sender_id = $1 OR m.recipient_id = $1)
     ORDER BY m.thread_id, m.sent_at DESC`,
    [userId, schoolId]
  );

  const unreadResult = await pool.query<{ thread_id: string; unread_count: string }>(
    `SELECT thread_id, COUNT(*) AS unread_count
     FROM messages
     WHERE school_id = $2 AND recipient_id = $1 AND is_read = FALSE
     GROUP BY thread_id`,
    [userId, schoolId]
  );
  const unreadByThread = new Map(unreadResult.rows.map(r => [r.thread_id, Number(r.unread_count)]));

  return result.rows
    .map(r => ({ ...r, unread_count: unreadByThread.get(r.thread_id) ?? 0 }))
    .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());
}

/** All messages in a thread, oldest first. */
export async function getThreadMessages(threadId: string, schoolId: string): Promise<ThreadMessageRow[]> {
  const result = await pool.query<ThreadMessageRow>(
    `SELECT m.id, m.thread_id, m.subject, m.body, m.sent_at, m.is_read, m.sender_id, m.recipient_id,
            su.first_name AS sender_first_name, su.last_name AS sender_last_name, su.role AS sender_role
     FROM messages m
     JOIN users su ON su.id = m.sender_id
     WHERE m.thread_id = $1 AND m.school_id = $2
     ORDER BY m.sent_at ASC`,
    [threadId, schoolId]
  );
  return result.rows;
}

/** Mark all unread messages addressed to this user in the thread as read. */
export async function markThreadRead(threadId: string, userId: string, schoolId: string): Promise<void> {
  await pool.query(
    `UPDATE messages SET is_read = TRUE
     WHERE thread_id = $1 AND school_id = $2 AND recipient_id = $3 AND is_read = FALSE`,
    [threadId, schoolId, userId]
  );
}
