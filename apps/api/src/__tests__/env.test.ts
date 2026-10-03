import { validateEnv } from '../config/env';

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/chronixedu',
    JWT_SECRET: 'a'.repeat(32),
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    APP_URL: 'https://edu.example.test',
    TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...overrides,
  };
}

describe('validateEnv', () => {
  it('throws when DATABASE_URL is missing', () => {
    const env = validEnv({ DATABASE_URL: undefined });
    expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
  });

  it('throws when JWT_SECRET is shorter than 32 characters', () => {
    const env = validEnv({ JWT_SECRET: 'too-short' });
    expect(() => validateEnv(env)).toThrow(/JWT_SECRET/);
  });

  it('throws when SUPABASE_URL is not a valid URL', () => {
    const env = validEnv({ SUPABASE_URL: 'not-a-url' });
    expect(() => validateEnv(env)).toThrow(/SUPABASE_URL/);
  });

  it('refuses to start without APP_URL, whatever NEXTAUTH_URL says (no localhost default)', () => {
    expect(() => validateEnv(validEnv({ APP_URL: undefined, NEXTAUTH_URL: 'http://localhost:3000' }))).toThrow(/APP_URL is required/);
    expect(() => validateEnv(validEnv({ APP_URL: 'not-a-url' }))).toThrow(/APP_URL must be a valid URL/);
    expect(validateEnv(validEnv()).APP_URL).toBe('https://edu.example.test');
  });

  it('refuses to start without a 32-byte TOTP_ENCRYPTION_KEY (it encrypts the admins authenticator secrets)', () => {
    // The control: a valid key is accepted, so the refusals below are about the key.
    expect(validateEnv(validEnv()).TOTP_ENCRYPTION_KEY).toBe(Buffer.alloc(32, 7).toString('base64'));
    expect(() => validateEnv(validEnv({ TOTP_ENCRYPTION_KEY: undefined }))).toThrow(/TOTP_ENCRYPTION_KEY is required/);
    for (const bad of [Buffer.alloc(16, 7).toString('base64'), Buffer.alloc(48, 7).toString('base64'), 'not base64 at all!!', Buffer.alloc(32, 7).toString('hex')]) {
      expect(() => validateEnv(validEnv({ TOTP_ENCRYPTION_KEY: bad }))).toThrow(/TOTP_ENCRYPTION_KEY must be exactly 32 bytes/);
    }
  });

  it('throws when DATABASE_URL does not use a postgres scheme', () => {
    const env = validEnv({ DATABASE_URL: 'mysql://user:pass@localhost:3306/db' });
    expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
  });

  it('reports every missing required variable in a single error', () => {
    const env = validEnv({ DATABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
    let message = '';
    try {
      validateEnv(env);
    } catch (err) {
      message = err instanceof Error ? err.message : '';
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('applies defaults for PORT, NODE_ENV and SUPABASE_STORAGE_BUCKET when unset', () => {
    const env = validEnv({ PORT: undefined, NODE_ENV: undefined, SUPABASE_STORAGE_BUCKET: undefined });
    const result = validateEnv(env);
    expect(result.PORT).toBe(3001);
    expect(result.NODE_ENV).toBe('development');
    expect(result.SUPABASE_STORAGE_BUCKET).toBe('school-assets');
  });

  it('coerces a numeric PORT string to a number', () => {
    const env = validEnv({ PORT: '4000' });
    const result = validateEnv(env);
    expect(result.PORT).toBe(4000);
  });

  it('returns the validated values for a fully valid environment', () => {
    const env = validEnv();
    const result = validateEnv(env);
    expect(result.DATABASE_URL).toBe(env.DATABASE_URL);
    expect(result.JWT_SECRET).toBe(env.JWT_SECRET);
    expect(result.SUPABASE_URL).toBe(env.SUPABASE_URL);
  });
});
