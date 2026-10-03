import { encryptTotpSecret, decryptTotpSecret, parseTotpKey } from '../services/totpSecretBox';
import { base32Encode, generateTotpSecret } from '../services/totp';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('the TOTP secret at rest', () => {
  it('decrypts back to the same secret for the same admin', () => {
    const secret = generateTotpSecret();
    expect(decryptTotpSecret(encryptTotpSecret(secret, ADMIN), ADMIN).equals(secret)).toBe(true);
  });

  it('holds neither the raw secret nor its base32 form, and differs each time', () => {
    const secret = generateTotpSecret();
    const a = encryptTotpSecret(secret, ADMIN);
    const b = encryptTotpSecret(secret, ADMIN);
    expect(a.includes(secret)).toBe(false);
    expect(a.toString('latin1').includes(base32Encode(secret))).toBe(false);
    expect(a.equals(b)).toBe(false); // a fresh IV each time
  });

  it('refuses a ciphertext moved onto another admin, altered by one bit, or made under another key', () => {
    const secret = generateTotpSecret();
    const stored = encryptTotpSecret(secret, ADMIN);
    // The control: the untouched value decrypts, so each refusal below is about its change.
    expect(decryptTotpSecret(stored, ADMIN).equals(secret)).toBe(true);

    expect(() => decryptTotpSecret(stored, OTHER)).toThrow();

    const flipped = Buffer.from(stored);
    flipped[flipped.length - 1] ^= 1;
    expect(() => decryptTotpSecret(flipped, ADMIN)).toThrow();

    const saved = process.env.TOTP_ENCRYPTION_KEY;
    try {
      process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
      expect(() => decryptTotpSecret(stored, ADMIN)).toThrow();
    } finally {
      process.env.TOTP_ENCRYPTION_KEY = saved;
    }
  });

  it('refuses to work without a valid key, rather than encrypting under nothing', () => {
    const saved = process.env.TOTP_ENCRYPTION_KEY;
    try {
      delete process.env.TOTP_ENCRYPTION_KEY;
      expect(() => encryptTotpSecret(generateTotpSecret(), ADMIN)).toThrow(/TOTP_ENCRYPTION_KEY/);
      process.env.TOTP_ENCRYPTION_KEY = 'short';
      expect(() => encryptTotpSecret(generateTotpSecret(), ADMIN)).toThrow(/TOTP_ENCRYPTION_KEY/);
    } finally {
      process.env.TOTP_ENCRYPTION_KEY = saved;
    }
  });

  it('parseTotpKey accepts exactly 32 bytes of canonical base64', () => {
    expect(parseTotpKey(Buffer.alloc(32, 1).toString('base64'))?.length).toBe(32);
    for (const bad of [undefined, '', Buffer.alloc(31, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), Buffer.alloc(32, 1).toString('hex')]) {
      expect(parseTotpKey(bad)).toBeNull();
    }
  });
});
