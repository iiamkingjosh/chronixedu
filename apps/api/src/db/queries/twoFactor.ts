import pool from '../client';
import { encryptTotpSecret, decryptTotpSecret } from '../../services/totpSecretBox';
import { hashRecoveryCode } from '../../services/recoveryCodes';

/**
 * Platform-admin two-factor storage (migration 055). The secret is encrypted before it reaches the
 * database and decrypted after it leaves; recovery codes arrive as plain text from the admin and
 * leave this module only as hashes. Nothing here logs either.
 */

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

export async function readTotpSecret(userId: string): Promise<{ secret: Buffer; activatedAt: Date | null } | null> {
  const { rows } = await pool.query<{ secret_ciphertext: Buffer; activated_at: Date | null }>(
    `SELECT secret_ciphertext, activated_at FROM user_totp WHERE user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  return { secret: decryptTotpSecret(rows[0].secret_ciphertext, userId), activatedAt: rows[0].activated_at };
}

/** Replaces the admin's whole set of recovery codes with these, in one transaction. */
export async function replaceRecoveryCodes(userId: string, codes: string[]): Promise<void> {
  const hashes = codes.map((c) => {
    const h = hashRecoveryCode(c);
    if (!h) throw new Error('replaceRecoveryCodes: a generated code did not normalise');
    return h;
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
    await client.query(
      `INSERT INTO user_recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])`,
      [userId, hashes]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // silent-ok: the original error is rethrown next
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Spends one recovery code. True only for an unused code of this admin; the UPDATE's own WHERE
 * makes it single-use even when two requests race with the same code.
 */
export async function consumeRecoveryCode(userId: string, typed: string): Promise<boolean> {
  const hash = hashRecoveryCode(typed);
  if (!hash) return false;
  const { rowCount } = await pool.query(
    `UPDATE user_recovery_codes SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hash]
  );
  return rowCount === 1;
}

export async function unusedRecoveryCodeCount(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  return rows[0].n;
}
