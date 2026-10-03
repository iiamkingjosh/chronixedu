import crypto from 'crypto';
import type { ClientBase } from 'pg';

/**
 * The second step of a platform admin's sign-in (migration 057). After a correct password, an admin
 * with two-factor on is handed a challenge instead of a token. These run on the login connection
 * (routes/auth.ts), never the app pool, because the caller is not signed in yet (decision d).
 *
 * The raw challenge exists only in the response and in the browser's memory. The database keeps its
 * SHA-256, so a read of the table cannot be replayed.
 */
type Db = Pick<ClientBase, 'query'>;

export const CHALLENGE_TTL_SECONDS = 5 * 60;
/** Wrong codes one challenge allows. The lock that matters is per account (user_totp, 056). */
export const CHALLENGE_MAX_ATTEMPTS = 5;

function hash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Issues a challenge, first clearing this admin's dead ones (the table's only retention). */
export async function createLoginChallenge(db: Db, userId: string, ipAddress: string | null): Promise<string> {
  await db.query(
    `DELETE FROM login_challenges WHERE user_id = $1 AND (consumed_at IS NOT NULL OR expires_at <= now())`,
    [userId]
  );
  const raw = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO login_challenges (challenge_hash, user_id, expires_at, ip_address)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4)`,
    [hash(raw), userId, CHALLENGE_TTL_SECONDS, ipAddress]
  );
  return raw;
}

export interface LiveChallenge {
  id: string;
  userId: string;
  attempts: number;
}

/** The challenge, if it is still usable: not consumed, not expired, wrong codes left. */
export async function findLiveChallenge(db: Db, raw: string): Promise<LiveChallenge | null> {
  const { rows } = await db.query<{ id: string; user_id: string; attempts: number }>(
    `SELECT id, user_id, attempts FROM login_challenges
      WHERE challenge_hash = $1 AND consumed_at IS NULL AND expires_at > now() AND attempts < $2`,
    [hash(raw), CHALLENGE_MAX_ATTEMPTS]
  );
  return rows[0] ? { id: rows[0].id, userId: rows[0].user_id, attempts: rows[0].attempts } : null;
}

/** Counts a wrong code against the challenge; at CHALLENGE_MAX_ATTEMPTS it is dead. Returns attempts. */
export async function recordChallengeFailure(db: Db, id: string): Promise<number> {
  const { rows } = await db.query<{ attempts: number }>(
    `UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
    [id]
  );
  return rows[0]?.attempts ?? CHALLENGE_MAX_ATTEMPTS;
}

/** Spends the challenge. True for the one request that does; a second gets false. */
export async function spendChallenge(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE login_challenges SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [id]
  );
  return rowCount === 1;
}
