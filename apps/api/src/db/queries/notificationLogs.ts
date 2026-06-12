import pool from '../client';

export interface NotificationLogInput {
  school_id: string;
  user_id: string;
  channel: string;
  type: string;
  status: 'sent' | 'failed' | 'throttled';
  detail?: string | null;
}

export async function insertNotificationLog(data: NotificationLogInput): Promise<void> {
  await pool.query(
    `INSERT INTO notification_logs (school_id, user_id, channel, type, status, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [data.school_id, data.user_id, data.channel, data.type, data.status, data.detail ?? null]
  );
}

const SMS_DAILY_LIMIT = 3;

export async function hasReachedSmsLimit(userId: string): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM notification_logs
     WHERE user_id = $1 AND channel = 'sms' AND status = 'sent'
       AND created_at >= NOW() - INTERVAL '1 day'`,
    [userId]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10) >= SMS_DAILY_LIMIT;
}
