import {
  base32Encode, base32Decode, hotp, totp, matchTotpStep, otpauthUri, generateTotpSecret,
  totpStep, TOTP_STEP_SECONDS, TOTP_SECRET_BYTES,
} from '../services/totp';

// The shared secret both RFCs use for their SHA-1 tables: the ASCII digits 1234567890, twice.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP, against RFC 4226 Appendix D', () => {
  it('produces the published 6-digit value for counters 0 to 9', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, counter) => hotp(RFC_SECRET, counter))).toEqual(expected);
  });
});

describe('TOTP, against RFC 6238 Appendix B (SHA-1, 8 digits)', () => {
  it('produces the published value at each published time', () => {
    const table: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [time, code] of table) expect({ time, code: totp(RFC_SECRET, time, 8) }).toEqual({ time, code });
  });
});

describe('base32 (RFC 4648 §10)', () => {
  it('encodes the published vectors, unpadded as authenticator apps expect', () => {
    const vectors: Array<[string, string]> = [
      ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) expect(base32Encode(Buffer.from(plain))).toBe(encoded);
  });

  it('decodes what it encodes, and what people type: padding, lower case and spaces', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = generateTotpSecret();
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow(/not a base32 character/);
  });

  it('makes a 160-bit secret, which is 32 base32 characters', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBe(TOTP_SECRET_BYTES);
    expect(base32Encode(secret)).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe('matchTotpStep', () => {
  const now = 1_759_500_000; // a fixed moment, so the test does not depend on the clock

  it('accepts the current code and one step of drift either way, naming the step', () => {
    for (const drift of [-1, 0, 1]) {
      const code = totp(RFC_SECRET, now + drift * TOTP_STEP_SECONDS);
      expect(matchTotpStep(RFC_SECRET, code, now)).toBe(totpStep(now) + drift);
    }
  });

  it('refuses a code two steps away, another secret\'s code, and anything not six digits', () => {
    // The control: the current code is accepted, so each refusal is about its input.
    expect(matchTotpStep(RFC_SECRET, totp(RFC_SECRET, now), now)).not.toBeNull();
    expect(matchTotpStep(RFC_SECRET, totp(RFC_SECRET, now + 2 * TOTP_STEP_SECONDS), now)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, totp(generateTotpSecret(), now), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', '12345a', ' 123456', '١٢٣٤٥٦']) expect(matchTotpStep(RFC_SECRET, bad, now)).toBeNull();
  });
});

describe('otpauthUri', () => {
  it('names SHA1, six digits and thirty seconds, with the secret in base32', () => {
    const secret = generateTotpSecret();
    const uri = new URL(otpauthUri(secret, 'admin@example.test'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Chronix Edu:admin@example.test');
    expect(uri.searchParams.get('secret')).toBe(base32Encode(secret));
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
    expect(uri.searchParams.get('issuer')).toBe('Chronix Edu');
  });
});
