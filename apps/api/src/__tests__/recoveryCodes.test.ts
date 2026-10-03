import { generateRecoveryCodes, normalizeRecoveryCode, hashRecoveryCode, RECOVERY_CODE_COUNT } from '../services/recoveryCodes';

describe('recovery codes', () => {
  it('makes ten different codes of 16 Crockford characters in four groups', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  it('reads a code back however it is typed: case, spaces, no dashes, and I, L, O for 1, 1, 0', () => {
    const [code] = generateRecoveryCodes();
    const canonical = code.replace(/-/g, '');
    const misread = canonical.replace(/1/g, 'l').replace(/0/g, 'O').toLowerCase();
    for (const typed of [code, canonical, code.toLowerCase(), ` ${code.replace(/-/g, ' ')} `, misread]) {
      expect({ typed, read: normalizeRecoveryCode(typed) }).toEqual({ typed, read: canonical });
    }
  });

  it('refuses what cannot be a code', () => {
    for (const bad of ['', 'ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMN-PQRSX', 'ABCD-EFGH-JKMN-PQRU', '!!!!-!!!!-!!!!-!!!!']) {
      expect({ bad, read: normalizeRecoveryCode(bad) }).toEqual({ bad, read: null });
      expect(hashRecoveryCode(bad)).toBeNull();
    }
  });

  it('stores a SHA-256 that is the same however the code is typed, and never the code', () => {
    const [code] = generateRecoveryCodes();
    const hash = hashRecoveryCode(code)!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(hash);
    expect(hash.includes(code.replace(/-/g, '').toLowerCase())).toBe(false);
    expect(hashRecoveryCode(generateRecoveryCodes()[0])).not.toBe(hash);
  });
});
