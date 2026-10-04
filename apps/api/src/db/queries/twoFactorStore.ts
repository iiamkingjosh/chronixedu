import type { ClientBase, PoolClient } from 'pg';
import pool from '../client';
import { encryptTotpSecret, decryptTotpSecret } from '../../services/totpSecretBox';
import { hashRecoveryCode } from '../../services/recoveryCodes';
import { logPlatformAudit, type PlatformAuditEntry } from './platformAudit';

/**
 * Platform-admin two-factor storage (migrations 055, 056). The secret is encrypted before it reaches
 * the database and decrypted after it leaves; recovery codes arrive as plain text and leave this
 * module only as hashes. Nothing here logs either.
 */

/**
 * Any connection: the app pool by default, or the login connection, which the sign-in step uses so
 * that an unauthenticated route never reaches the app pool (decision d, docs/c4a/grants.sql).
 */
type Db = Pick<ClientBase, 'query'>;

/** Wrong codes in a row before the factor locks, and for how long (decision c, migration 056). */
export const TOTP_LOCK_AFTER = 10;
export const TOTP_LOCK_MINUTES = 15;

async function inTransaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // silent-ok: the original error is rethrown next
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Stores a new, not yet active secret. Refuses (returns false) when the admin already has an
 * ACTIVE one: replacing a working authenticator is a separate, audited act, not a side effect of
 * starting enrolment again.
 */
export async function savePendingTotpSecret(userId: string, secret: Buffer): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO user_totp (user_id, secret_ciphertext, created_at, activated_at)
     VALUES ($1, $2, now(), NULL)
     ON CONFLICT (user_id) DO UPDATE
       SET secret_ciphertext = EXCLUDED.secret_ciphertext, created_at = now()
       WHERE user_totp.activated_at IS NULL`,
    [userId, encryptTotpSecret(secret, userId)]
  );
  return rowCount === 1;
}

export async function readTotpSecret(userId: string, db: Db = pool): Promise<{ secret: Buffer; activatedAt: Date | null } | null> {
  const { rows } = await db.query<{ secret_ciphertext: Buffer; activated_at: Date | null }>(
    `SELECT secret_ciphertext, activated_at FROM user_totp WHERE user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  return { secret: decryptTotpSecret(rows[0].secret_ciphertext, userId), activatedAt: rows[0].activated_at };
}

export interface TotpState {
  activatedAt: Date | null;
  lockedUntil: Date | null;
  failedAttempts: number;
}

/** Where the admin's second factor stands, without decrypting anything. */
export async function readTotpState(userId: string, db: Db = pool): Promise<TotpState | null> {
  const { rows } = await db.query<{ activated_at: Date | null; locked_until: Date | null; failed_attempts: number }>(
    `SELECT activated_at, locked_until, failed_attempts FROM user_totp WHERE user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  return { activatedAt: rows[0].activated_at, lockedUntil: rows[0].locked_until, failedAttempts: rows[0].failed_attempts };
}

export function isLocked(state: TotpState | null, now: Date = new Date()): boolean {
  return !!state?.lockedUntil && state.lockedUntil > now;
}

async function writeRecoveryCodes(client: PoolClient, userId: string, codes: string[]): Promise<void> {
  const hashes = codes.map((c) => {
    const h = hashRecoveryCode(c);
    if (!h) throw new Error('writeRecoveryCodes: a generated code did not normalise');
    return h;
  });
  await client.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  await client.query(`INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])`, [userId, hashes]);
}

/** Replaces the admin's whole set of recovery codes with these, in one transaction. */
export async function replaceRecoveryCodes(userId: string, codes: string[], audit?: PlatformAuditEntry): Promise<void> {
  await inTransaction(async (c) => {
    await writeRecoveryCodes(c, userId, codes);
    if (audit) await logPlatformAudit(audit, c);
  });
}

/**
 * Switches a pending enrolment on, in one transaction with its audit row (doctrine 10):
 *  - the factor becomes active, with the confirming code's step as the last one used (replay);
 *  - the recovery codes are written;
 *  - every session the admin had is ended (users.sessions_valid_after; verifyToken refuses older
 *    tokens), so a session stolen before enrolment does not outlive it.
 * False when there was no pending enrolment to switch on.
 */
export async function activateTotp(userId: string, step: number, codes: string[], audit: PlatformAuditEntry): Promise<boolean> {
  return inTransaction(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE user_totp SET activated_at = now(), last_used_step = $2, failed_attempts = 0, locked_until = NULL
        WHERE user_id = $1 AND activated_at IS NULL`,
      [userId, step]
    );
    if (rowCount !== 1) return false;
    await writeRecoveryCodes(c, userId, codes);
    await c.query(`UPDATE users SET sessions_valid_after = now() WHERE id = $1`, [userId]);
    await logPlatformAudit(audit, c);
    return true;
  });
}

/** How long a started phone move waits for a code from the new phone (migration 059). */
export const DEVICE_MOVE_MINUTES = 15;

/**
 * Starts moving an ACTIVE factor to a new phone: the new secret waits beside the working one, which
 * stays in use until completeDeviceMove. Starting again replaces an earlier pending secret. False when
 * the factor is not active.
 */
export async function savePendingDeviceMove(userId: string, secret: Buffer): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE user_totp SET pending_secret_ciphertext = $2, pending_created_at = now()
      WHERE user_id = $1 AND activated_at IS NOT NULL`,
    [userId, encryptTotpSecret(secret, userId)]
  );
  return rowCount === 1;
}

/**
 * The new phone's secret, if a move was started within DEVICE_MOVE_MINUTES, with the stored bytes it
 * came from: completeDeviceMove switches to exactly those bytes, so a move started again in another tab
 * between the check and the switch cannot put an unconfirmed secret in place.
 */
export async function readPendingDeviceMove(userId: string): Promise<{ secret: Buffer; ciphertext: Buffer } | null> {
  const { rows } = await pool.query<{ pending_secret_ciphertext: Buffer }>(
    `SELECT pending_secret_ciphertext FROM user_totp
      WHERE user_id = $1 AND activated_at IS NOT NULL AND pending_secret_ciphertext IS NOT NULL
        AND pending_created_at > now() - make_interval(mins => $2)`,
    [userId, DEVICE_MOVE_MINUTES]
  );
  if (!rows[0]) return null;
  const ciphertext = rows[0].pending_secret_ciphertext;
  return { secret: decryptTotpSecret(ciphertext, userId), ciphertext };
}

/**
 * Finishes a phone move, in one transaction with its audit row (doctrine 10):
 *  - the confirmed pending secret becomes the active one, with the confirming code's step as the last
 *    one used (replay), and the failure count and any lock cleared;
 *  - the recovery codes are kept: they did not travel with the phone (decided 4 Oct 2026);
 *  - every other session the admin had is ended, as at enrolment (users.sessions_valid_after).
 * False when the pending secret is gone, has expired, or is no longer the one that was checked.
 */
export async function completeDeviceMove(userId: string, checkedCiphertext: Buffer, step: number, audit: PlatformAuditEntry): Promise<boolean> {
  return inTransaction(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE user_totp
          SET secret_ciphertext = pending_secret_ciphertext,
              pending_secret_ciphertext = NULL, pending_created_at = NULL,
              last_used_step = $3, failed_attempts = 0, locked_until = NULL
        WHERE user_id = $1 AND activated_at IS NOT NULL
          AND pending_secret_ciphertext = $2
          AND pending_created_at > now() - make_interval(mins => $4)`,
      [userId, checkedCiphertext, step, DEVICE_MOVE_MINUTES]
    );
    if (rowCount !== 1) return false;
    await c.query(`UPDATE users SET sessions_valid_after = now() WHERE id = $1`, [userId]);
    await logPlatformAudit(audit, c);
    return true;
  });
}

/**
 * Sets whether this platform admin must have two-factor (migration 058). The previous value is read
 * under the same row lock as the write and goes into the audit row, in one transaction (doctrine 10),
 * so turning it off is never quiet. No audit row when nothing changes. Null when the user is not a
 * platform admin.
 */
export async function setTwoFactorRequired(
  userId: string, required: boolean, ipAddress: string | null
): Promise<{ previous: boolean; changed: boolean } | null> {
  return inTransaction(async (c) => {
    const { rows } = await c.query<{ two_factor_required: boolean }>(
      `SELECT two_factor_required FROM users WHERE id = $1 AND role = 'super_admin' FOR UPDATE`,
      [userId]
    );
    if (!rows[0]) return null;
    const previous = rows[0].two_factor_required;
    if (previous === required) return { previous, changed: false };
    await c.query(`UPDATE users SET two_factor_required = $2 WHERE id = $1`, [userId, required]);
    await logPlatformAudit({
      adminId: userId,
      actionType: 'TWO_FACTOR_REQUIREMENT_SET',
      targetUserId: userId,
      metadata: { previous, required },
      ipAddress,
    }, c);
    return { previous, changed: true };
  });
}

/**
 * Accepts a code's time step for an ACTIVE factor and resets the failure count. Refuses a step at or
 * before the last one used (a replayed code) and refuses while locked; the WHERE makes both hold
 * even when two requests race with the same code.
 */
export async function acceptTotpStep(userId: string, step: number, db: Db = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE user_totp SET last_used_step = $2, failed_attempts = 0
      WHERE user_id = $1 AND activated_at IS NOT NULL
        AND (last_used_step IS NULL OR last_used_step < $2)
        AND (locked_until IS NULL OR locked_until <= now())`,
    [userId, step]
  );
  return rowCount === 1;
}

/**
 * Counts one wrong code. At TOTP_LOCK_AFTER in a row the factor locks for TOTP_LOCK_MINUTES; the
 * count is cleared only by a right code, so after a lock ends each further wrong code locks again.
 */
export async function recordTotpFailure(userId: string, db: Db = pool): Promise<{ failedAttempts: number; locked: boolean }> {
  const { rows } = await db.query<{ failed_attempts: number; locked_until: Date | null }>(
    `UPDATE user_totp
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE user_id = $1
      RETURNING failed_attempts, locked_until`,
    [userId, TOTP_LOCK_AFTER, TOTP_LOCK_MINUTES]
  );
  const failedAttempts = rows[0]?.failed_attempts ?? 0;
  return { failedAttempts, locked: failedAttempts >= TOTP_LOCK_AFTER };
}

/**
 * Spends one recovery code. True only for an unused code of this admin; the UPDATE's own WHERE
 * makes it single-use even when two requests race with the same code.
 */
export async function consumeRecoveryCode(userId: string, typed: string, db: Db = pool): Promise<boolean> {
  const hash = hashRecoveryCode(typed);
  if (!hash) return false;
  const { rowCount } = await db.query(
    `UPDATE user_recovery_codes SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hash]
  );
  return rowCount === 1;
}

export async function unusedRecoveryCodeCount(userId: string, db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return rows[0].n;
}

/**
 * Whether this platform admin must switch two-factor on (migration 058): true for an admin created
 * since, false for one who existed before (the choice stays theirs). NULL never reaches here for a
 * super_admin, because the CHECK refuses it.
 */
export async function isTwoFactorRequired(userId: string, db: Db = pool): Promise<boolean> {
  const { rows } = await db.query<{ two_factor_required: boolean | null }>(
    `SELECT two_factor_required FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0]?.two_factor_required !== false;
}

/** Whether the admin has switched two-factor on (an active row, not a pending enrolment). */
export async function isTwoFactorActive(userId: string, db: Db = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM user_totp WHERE user_id = $1 AND activated_at IS NOT NULL`,
    [userId]
  );
  return rowCount === 1;
}

/**
 * Clears the consecutive-failure count after the admin has proved who they are some other way: a
 * recovery code at sign-in. A right authenticator code clears it in acceptTotpStep.
 */
export async function clearTotpFailures(userId: string, db: Db = pool): Promise<void> {
  await db.query(`UPDATE user_totp SET failed_attempts = 0 WHERE user_id = $1 AND activated_at IS NOT NULL`, [userId]);
}

/**
 * Removes an admin's second factor and recovery codes, for an admin who is being removed. Deleting
 * an active factor is recorded by migration 055's trigger (TWO_FACTOR_REMOVED).
 */
export async function removeTwoFactor(userId: string, client?: PoolClient): Promise<void> {
  const q = client ?? pool;
  await q.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  await q.query(`DELETE FROM user_totp WHERE user_id = $1`, [userId]);
}
