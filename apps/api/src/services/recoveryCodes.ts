import crypto from 'crypto';

/**
 * One-time recovery codes for platform-admin two-factor sign-in (3 Oct 2026). They exist for the
 * day the phone is lost. Production has exactly one platform admin who can sign in, so a lost
 * phone without these means break-glass in the database (docs/admin-two-factor-runbook.md).
 *
 * Ten codes, each 80 random bits, written as 16 Crockford base32 characters in four groups
 * (`7KQ2-M9XD-4HNP-T0WC`). Crockford leaves out I, L, O and U, and reading accepts I and L as 1
 * and O as 0, so a code copied by hand survives the usual misreadings.
 *
 * Shown once, at the moment they are made, and stored only as SHA-256 hashes. A slow hash is not
 * needed: guessing an 80-bit value from its hash is out of reach, which is what a slow hash buys
 * for a low-entropy password. Each is single-use (db/queries/twoFactor.ts consumes one atomically).
 */

export const RECOVERY_CODE_COUNT = 10;
const CODE_BYTES = 10; // 80 bits
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out; // 80 bits is exactly 16 characters, so nothing is left over
}

/** Ten fresh codes, formatted for showing to the admin. */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(encode(crypto.randomBytes(CODE_BYTES)).match(/.{4}/g)!.join('-'));
  }
  return [...codes];
}

/** A typed code in canonical form (16 characters, no separators), or null if it cannot be one. */
export function normalizeRecoveryCode(input: string): string | null {
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (canonical.length !== 16) return null;
  for (const ch of canonical) if (!CROCKFORD.includes(ch)) return null;
  return canonical;
}

/** What is stored: the SHA-256 of the canonical form, as hex. */
export function hashRecoveryCode(input: string): string | null {
  const canonical = normalizeRecoveryCode(input);
  return canonical === null ? null : crypto.createHash('sha256').update(canonical).digest('hex');
}
