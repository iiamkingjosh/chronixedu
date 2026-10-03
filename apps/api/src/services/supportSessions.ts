import pool from '../db/client';
import { redis } from '../middleware/rateLimit';

/**
 * Ends every support (impersonation) session a platform admin has open, and blacklists each one's
 * scoped token so it cannot outlive the end. Used when an admin is suspended or removed
 * (routes/superAdmin.ts) and when an admin enrols in two-factor (routes/twoFactor.ts), so that a
 * support token minted from a session stolen before enrolment does not survive it.
 *
 * Moved unchanged from routes/superAdmin.ts on 3 Oct 2026. Its Redis writes are deliberately not
 * best-effort (CLAUDE.md, Auth: the support-session token store and blacklist writers are the
 * exception): a blacklist write that silently failed would leave a revoked token working.
 */
export async function terminateActiveSupportSessions(adminId: string): Promise<void> {
  const activeSessions = await pool.query<{ id: string }>(
    `SELECT id FROM support_sessions WHERE platform_admin_id = $1 AND ended_at IS NULL`,
    [adminId]
  );
  if (activeSessions.rows.length === 0) return;

  if (redis) {
    for (const { id } of activeSessions.rows) {
      const storedToken = await redis.get(`support_session_token:${id}`);
      if (storedToken) {
        await redis.set(`blacklisted_token:${storedToken}`, '1', 'EX', 30 * 60);
        await redis.del(`support_session_token:${id}`);
      }
    }
  }

  await pool.query(
    `UPDATE support_sessions SET ended_at = NOW() WHERE platform_admin_id = $1 AND ended_at IS NULL`,
    [adminId]
  );
}
