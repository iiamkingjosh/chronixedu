import crypto from 'crypto';

/**
 * Time-based one-time passwords for platform-admin two-factor sign-in (RFC 6238, built on the
 * HOTP of RFC 4226). Written here over Node's crypto rather than taken from a library (decided
 * 3 Oct 2026): it is short, both RFCs publish test vectors for the one subtle step (dynamic
 * truncation), and an auth primitive from a dependency is supply-chain surface for no capability
 * Node lacks. Tested against both RFC tables and the RFC 4648 base32 vectors (totp.test.ts).
 *
 * SHA-1 IS DELIBERATE. It is the RFC default, and Google Authenticator and most other apps ignore
 * the `algorithm` parameter in the otpauth URI and always use SHA-1. "Improving" this to SHA-256
 * produces codes that silently never match. HMAC-SHA-1 is not weakened by SHA-1's collision
 * attacks, which is why the RFC keeps it.
 */

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/** Steps either side of now that are accepted, for clock drift between server and phone. */
export const TOTP_WINDOW = 1;
/** 160 bits, the length RFC 4226 recommends for the shared secret. */
export const TOTP_SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded: what authenticator apps expect in an otpauth URI. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 to bytes. Accepts lower case, spaces and padding, as people type them. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index === -1) throw new Error('base32Decode: not a base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return crypto.randomBytes(TOTP_SECRET_BYTES);
}

/** RFC 4226 HOTP: HMAC-SHA-1 over the 8-byte big-endian counter, dynamically truncated. */
export function hotp(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(message).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks an offset, and the
  // 31 bits read from there are the code before reduction.
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step a moment falls in. */
export function totpStep(unixSeconds: number): number {
  return Math.floor(unixSeconds / TOTP_STEP_SECONDS);
}

export function totp(secret: Buffer, unixSeconds: number, digits: number = TOTP_DIGITS): string {
  return hotp(secret, totpStep(unixSeconds), digits);
}

/**
 * The step a submitted code belongs to, within TOTP_WINDOW of now, or null. The caller must refuse
 * a step at or before the last one used (replay); this function cannot, as it holds no state.
 * Every candidate is compared, in constant time, so the timing does not say which step matched.
 */
export function matchTotpStep(secret: Buffer, code: string, unixSeconds: number): number | null {
  if (!/^\d+$/.test(code) || code.length !== TOTP_DIGITS) return null;
  const now = totpStep(unixSeconds);
  let matched: number | null = null;
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code)) && matched === null) matched = step;
  }
  return matched;
}

/**
 * The otpauth URI an authenticator app reads from the QR code. It contains the secret: it is
 * shown to the admin once at enrolment and is never logged, stored or put in an audit row.
 * algorithm=SHA1 is stated for apps that do read it; see the note at the top on why it is SHA-1.
 */
export function otpauthUri(secret: Buffer, accountName: string, issuer = 'Chronix Edu'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
