/**
 * A support token's life, its store and its revocation entry come from one number (4 Oct 2026,
 * docs/AUDIT-2026-09.md). They used to read SUPPORT_SESSION_MAX_DURATION_HOURS three ways: at 0.5
 * hours the store kept the token 60 s of its 30 minutes, and ending a session revoked nothing.
 */
import fs from 'fs';
import path from 'path';
import ms from 'ms';
import { parseSupportSessionHours, DEFAULT_SUPPORT_SESSION_SECONDS } from '../config/supportSession';
import { validateEnv } from '../config/env';

/** The parser jsonwebtoken uses for a string expiresIn, in seconds. */
const jwtSeconds = (text: string): number => (ms as unknown as (v: string) => number)(text) / 1000;

const BASE_ENV = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(40),
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'k',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  APP_URL: 'https://edu.example.test',
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('the support-session setting is read once, in seconds', () => {
  it('honours whole and fractional hours, and unset or blank is the 30-minute default', () => {
    expect(parseSupportSessionHours('2')).toBe(7200);
    expect(parseSupportSessionHours('1.5')).toBe(5400);
    expect(parseSupportSessionHours('0.5')).toBe(1800);
    expect(parseSupportSessionHours(undefined)).toBe(DEFAULT_SUPPORT_SESSION_SECONDS);
    expect(parseSupportSessionHours('  ')).toBe(DEFAULT_SUPPORT_SESSION_SECONDS);
    expect(DEFAULT_SUPPORT_SESSION_SECONDS).toBe(1800);
  });

  it('agrees with the parser jsonwebtoken uses for the old string form, where the old code did not', () => {
    for (const hours of ['2', '1.5', '0.5']) {
      expect({ hours, seconds: parseSupportSessionHours(hours) }).toEqual({ hours, seconds: jwtSeconds(`${hours}h`) });
    }
    // The control: the parseInt the token store used disagreed for both fractional values.
    expect(parseInt('1.5', 10) * 3600).not.toBe(jwtSeconds('1.5h'));
    expect(parseInt('0.5', 10) * 3600).toBe(0);
  });

  it('a value it cannot honour stops the API at boot, by name, rather than becoming a default', () => {
    for (const bad of ['2h', 'abc', '0', '-1', '0.0001', '1e3']) {
      expect({ bad, parsed: parseSupportSessionHours(bad) }).toEqual({ bad, parsed: null });
      expect(() => validateEnv({ ...BASE_ENV, SUPPORT_SESSION_MAX_DURATION_HOURS: bad }))
        .toThrow(/SUPPORT_SESSION_MAX_DURATION_HOURS/);
    }
    // The control: the same environment with a good value, and with none, starts.
    expect(() => validateEnv({ ...BASE_ENV, SUPPORT_SESSION_MAX_DURATION_HOURS: '0.5' })).not.toThrow();
    expect(() => validateEnv(BASE_ENV)).not.toThrow();
  });

  it('the store and the revocation list outlive the token, for a whole and a fractional setting', () => {
    for (const hours of ['2', '0.5']) {
      jest.isolateModules(() => {
        process.env.SUPPORT_SESSION_MAX_DURATION_HOURS = hours;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const s = require('../config/supportSession');
        expect(s.SUPPORT_SESSION_SECONDS).toBe(jwtSeconds(`${hours}h`));
        expect(s.SUPPORT_TOKEN_STORE_SECONDS).toBeGreaterThan(s.SUPPORT_SESSION_SECONDS);
        expect(s.SUPPORT_TOKEN_REVOKED_SECONDS).toBeGreaterThan(s.SUPPORT_SESSION_SECONDS);
      });
    }
    delete process.env.SUPPORT_SESSION_MAX_DURATION_HOURS;
  });

  it('nothing else reads the setting, and nothing types the token life', () => {
    const src = path.join(__dirname, '..');
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['__tests__', '__db_tests__'].includes(e.name)) walk(full); continue; }
        if (e.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('process.env.SUPPORT_SESSION_MAX_DURATION_HOURS')) {
          readers.push(path.relative(src, full).split(path.sep).join('/'));
        }
      }
    };
    walk(src);
    expect(readers.sort()).toEqual(['config/supportSession.ts']);
  });
});
