import { validateEnv } from '../config/env';

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/chronixedu',
    JWT_SECRET: 'a'.repeat(32),
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
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
