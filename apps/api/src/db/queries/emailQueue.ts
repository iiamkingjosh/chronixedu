import pool from '../client';

export interface QueuedEmail {
  id: string;
  to_email: string;
  subject: string;
  text_body: string;
  attempts: number;
}

export async function enqueueEmail(to: string, subject: string, text: string, error: string): Promise<void> {
  await pool.query(
    `INSERT INTO email_queue (to_email, subject, text_body, attempts, last_attempt_at, status, last_error)
     VALUES ($1, $2, $3, 1, now(), 'pending', $4)`,
    [to, subject, text, error]
  );
}

export async function getPendingEmails(maxAttempts: number): Promise<QueuedEmail[]> {
  const result = await pool.query<QueuedEmail>(
    `SELECT id, to_email, subject, text_body, attempts FROM email_queue
     WHERE status = 'pending' AND attempts < $1
     ORDER BY created_at ASC`,
    [maxAttempts]
  );
  return result.rows;
}

export async function markEmailSent(id: string): Promise<void> {
  await pool.query(`UPDATE email_queue SET status = 'sent', last_attempt_at = now() WHERE id = $1`, [id]);
}

export async function markEmailRetryFailed(id: string, attempts: number, maxAttempts: number, error: string): Promise<void> {
  const status = attempts >= maxAttempts ? 'failed' : 'pending';
  await pool.query(
    `UPDATE email_queue SET attempts = $2, last_attempt_at = now(), status = $3, last_error = $4 WHERE id = $1`,
    [id, attempts, status, error]
  );
}
