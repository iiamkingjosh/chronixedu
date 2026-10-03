import crypto from 'crypto';

/**
 * Encryption at rest for a platform admin's TOTP secret (3 Oct 2026). The secret is a credential:
 * anyone holding it can produce valid codes forever, so it is stored encrypted, never logged, never
 * sent to Sentry and never put in an audit row (CLAUDE.md doctrine 13's treatment). It cannot be
 * hashed, because the server must recompute codes from it.
 *
 * AES-256-GCM with a fresh 12-byte IV per encryption. The admin's user id is bound in as
 * additional authenticated data, so a ciphertext copied onto another admin's row fails to decrypt
 * instead of quietly giving that admin someone else's codes.
 *
 * Stored layout: [version 1 byte][IV 12][tag 16][ciphertext]. The version byte names the key
 * generation, so a key can be rotated later by adding a second one; there is one today.
 *
 * The key is TOTP_ENCRYPTION_KEY: 32 random bytes, base64. The API refuses to start without it
 * (config/env.ts). Losing it makes every enrolled secret unreadable, which puts every enrolled
 * admin through break-glass (docs/admin-two-factor-runbook.md), so it is kept in the password manager
 * as well as in Railway. It never leaves the API and is never logged, not even a prefix.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Decodes and checks the key. Shared with config/env.ts so boot and use agree on what is valid. */
export function parseTotpKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value, 'base64');
  // Re-encoding must give back the input: Buffer.from ignores characters that are not base64.
  if (key.length !== 32 || key.toString('base64') !== value) return null;
  return key;
}

function key(): Buffer {
  const k = parseTotpKey(process.env.TOTP_ENCRYPTION_KEY);
  if (!k) throw new Error('TOTP_ENCRYPTION_KEY is not set to 32 bytes of base64');
  return k;
}

function aad(userId: string): Buffer {
  return Buffer.from(`chronixedu:totp:v${VERSION}:${userId}`, 'utf8');
}

export function encryptTotpSecret(secret: Buffer, userId: string): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(aad(userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws if the stored value was altered, belongs to another user, or was made under another key. */
export function decryptTotpSecret(stored: Buffer, userId: string): Buffer {
  if (stored.length <= 1 + IV_BYTES + TAG_BYTES || stored[0] !== VERSION) {
    throw new Error('decryptTotpSecret: not a stored TOTP secret of a known version');
  }
  const iv = stored.subarray(1, 1 + IV_BYTES);
  const tag = stored.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = stored.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
