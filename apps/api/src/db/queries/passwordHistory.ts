import type { ClientBase } from 'pg';
import pool from '../client';

/**
 * password_history (migration 060): the bcrypt hash of each password an account replaced, and when.
 * Read and written only inside the transaction that changes a password (changeOwnPassword in
 * ./users.ts), apart from the daily retention delete. Never logged, never returned by any route.
 */

/** The hashes a new password must not match: the account's current one and those it replaced within `days`. */
export async function readRecentPasswordHashes(client: Pick<ClientBase, 'query'>, userId: string, days: number): Promise<string[]> {
  const result = await client.query<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1
     UNION ALL
     SELECT password_hash FROM password_history
      WHERE user_id = $1 AND retired_at > now() - make_interval(days => $2)`,
    [userId, days]
  );
  return result.rows.map(r => r.password_hash);
}

/**
 * Keeps the account's outgoing password, then drops its rows past the window. An outgoing value that
 * is not a bcrypt hash ('' for an account created with no password) is not kept: there is nothing to
 * compare a new password with.
 */
export async function retireCurrentPassword(client: Pick<ClientBase, 'query'>, userId: string, days: number): Promise<void> {
  await client.query(
    `INSERT INTO password_history (user_id, password_hash)
     SELECT id, password_hash FROM users WHERE id = $1 AND password_hash ~ '^\\$2[aby]\\$[0-9]{2}\\$'`,
    [userId]
  );
  await client.query(
    `DELETE FROM password_history WHERE user_id = $1 AND retired_at <= now() - make_interval(days => $2)`,
    [userId, days]
  );
}

/** The daily retention delete: every row past the window, for every account. Returns how many went. */
export async function deletePasswordHistoryOlderThan(days: number): Promise<number> {
  const result = await pool.query(
    `DELETE FROM password_history WHERE retired_at <= now() - make_interval(days => $1)`,
    [days]
  );
  return result.rowCount ?? 0;
}
