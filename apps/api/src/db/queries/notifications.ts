import pool from '../client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  payload: unknown;
  is_read: boolean;
  created_at: string;
}

export interface NewNotification {
  user_id: string;
  type: string;
  title: string;
  body?: string | null;
  payload?: unknown;
}

// ── Create ─────────────────────────────────────────────────────────────────────

export async function createNotification(data: NewNotification): Promise<NotificationRow> {
  const result = await pool.query<NotificationRow>(
    `INSERT INTO notifications (user_id, type, title, body, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, type, title, body, payload, is_read, created_at`,
    [data.user_id, data.type, data.title, data.body ?? null, data.payload ?? null]
  );
  return result.rows[0];
}

/** Insert the same notification for many users (e.g. an announcement fan-out). */
export async function createNotificationsBulk(userIds: string[], data: Omit<NewNotification, 'user_id'>): Promise<void> {
  if (userIds.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  userIds.forEach((userId, i) => {
    const base = i * 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    params.push(userId, data.type, data.title, data.body ?? null);
  });
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body) VALUES ${values.join(', ')}`,
    params
  );
}

// ── Read ───────────────────────────────────────────────────────────────────────

export async function listNotifications(userId: string, limit = 20): Promise<{ notifications: NotificationRow[]; unread_count: number }> {
  const [listResult, unreadResult] = await Promise.all([
    pool.query<NotificationRow>(
      `SELECT id, user_id, type, title, body, payload, is_read, created_at
       FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
      [userId]
    ),
  ]);
  return { notifications: listResult.rows, unread_count: parseInt(unreadResult.rows[0]?.count ?? '0', 10) };
}

export async function markNotificationRead(id: string, userId: string): Promise<void> {
  await pool.query(
    `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await pool.query(
    `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
    [userId]
  );
}
