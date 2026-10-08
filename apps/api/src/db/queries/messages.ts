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
// The current term of the current session. An older session can still hold a term marked current.
const CURRENT_TERM = `(SELECT t.id FROM terms t WHERE t.school_id = $2 AND t.is_current = TRUE AND t.session_id = ${CURRENT_SESSION})`;

// Who teaches a class: this term's assignments, plus the form teacher, who may have no assignment row.
// Expects a CTE `classes_of_interest(class_id)`.
const TEACHERS_OF_CLASSES = `
      SELECT ta.teacher_id AS id FROM teacher_assignments ta
      JOIN classes_of_interest ci ON ci.class_id = ta.class_id
      WHERE ta.school_id = $2 AND ta.term_id = ${CURRENT_TERM}
      UNION
      SELECT c.form_teacher_id FROM classes c
      JOIN classes_of_interest ci ON ci.class_id = c.id
      WHERE c.school_id = $2 AND c.form_teacher_id IS NOT NULL`;

const ACTIVE_PRINCIPALS = `
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM users u WHERE u.school_id = $2 AND u.role = 'principal' AND u.is_active = TRUE`;

// Contacts are people of this school who are active, and the teaching links are this term's and
// this session's (audit, 8 Oct 2026: they read assignments of any term, kept deactivated staff and
// left out the form teacher).
const CONTACT_QUERIES: Record<string, string> = {
  // Parent: this term's teachers of their children's classes this session, plus the principal.
  parent: `
    WITH classes_of_interest AS (
      SELECT sc.class_id
      FROM parent_students ps
      JOIN students s ON s.id = ps.student_id AND s.school_id = $2
      JOIN student_classes sc ON sc.student_id = s.id AND sc.session_id = ${CURRENT_SESSION}
      WHERE ps.parent_id = $1
    ),
    teachers AS (${TEACHERS_OF_CLASSES}
    ),
    contacts AS (
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM teachers t JOIN users u ON u.id = t.id
      WHERE u.school_id = $2 AND u.is_active = TRUE
      UNION${ACTIVE_PRINCIPALS}
    )
    SELECT * FROM contacts ORDER BY first_name, last_name`,

  // Teacher: the students they teach this session and those students' parents, the principal,
  // and other teachers. A teacher teaches a class through this term's assignment or as its form
  // teacher. Students are included so that a teacher can answer them (audit, Fix first 2).
  teacher: `
    WITH my_classes AS (
      SELECT ta.class_id FROM teacher_assignments ta
      WHERE ta.teacher_id = $1 AND ta.school_id = $2 AND ta.term_id = ${CURRENT_TERM}
      UNION
      SELECT c.id FROM classes c WHERE c.form_teacher_id = $1 AND c.school_id = $2
    ),
    my_students AS (
      SELECT DISTINCT sc.student_id
      FROM student_classes sc JOIN my_classes mc ON mc.class_id = sc.class_id
      WHERE sc.session_id = ${CURRENT_SESSION}
    ),
    people AS (
      SELECT ps.parent_id AS id FROM my_students ms JOIN parent_students ps ON ps.student_id = ms.student_id
      UNION
      SELECT s.user_id FROM my_students ms JOIN students s ON s.id = ms.student_id
    ),
    contacts AS (
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM people p JOIN users u ON u.id = p.id
      WHERE u.school_id = $2 AND u.is_active = TRUE
      UNION${ACTIVE_PRINCIPALS}
      UNION
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM users u WHERE u.school_id = $2 AND u.role = 'teacher' AND u.id != $1 AND u.is_active = TRUE
    )
    SELECT * FROM contacts ORDER BY first_name, last_name`,

  // Student: this term's teachers of their class this session, plus the principal.
  student: `
    WITH classes_of_interest AS (
      SELECT sc.class_id
      FROM students s
      JOIN student_classes sc ON sc.student_id = s.id AND sc.session_id = ${CURRENT_SESSION}
      WHERE s.user_id = $1 AND s.school_id = $2
    ),
    teachers AS (${TEACHERS_OF_CLASSES}
    ),
    contacts AS (
      SELECT u.id, u.first_name, u.last_name, u.role, u.email
      FROM teachers t JOIN users u ON u.id = t.id
      WHERE u.school_id = $2 AND u.is_active = TRUE
      UNION${ACTIVE_PRINCIPALS}
    )
    SELECT * FROM contacts ORDER BY first_name, last_name`,

  // Principal / super_admin: anyone else in the school.
  principal: `
    SELECT id, first_name, last_name, role, email
    FROM users WHERE school_id = $2 AND id != $1 AND is_active = TRUE
    ORDER BY role, first_name, last_name`,

  // Bursar: any principal, plus other bursars and registrars (the school's
  // admin staff) — not parents/students/teachers, whose fee questions should
  // route through the principal rather than directly to accounts.
  bursar: `
    SELECT id, first_name, last_name, role, email
    FROM users
    WHERE school_id = $2 AND id != $1 AND is_active = TRUE
      AND role IN ('principal', 'super_admin', 'bursar', 'registrar')
    ORDER BY role, first_name, last_name`,
};
CONTACT_QUERIES.super_admin = CONTACT_QUERIES.principal;
CONTACT_QUERIES.registrar = CONTACT_QUERIES.bursar;

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
