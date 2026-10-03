import { z } from 'zod';
import { parseTotpKey } from '../services/totpSecretBox';

const envSchema = z.object({
  DATABASE_URL: z
    .string({ message: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required')
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres connection string'),
  JWT_SECRET: z
    .string({ message: 'JWT_SECRET is required' })
    .min(32, 'JWT_SECRET must be at least 32 characters'),
  SUPABASE_URL: z
    .string({ message: 'SUPABASE_URL is required' })
    .url('SUPABASE_URL must be a valid URL'),
  SUPABASE_PUBLISHABLE_KEY: z
    .string({ message: 'SUPABASE_PUBLISHABLE_KEY is required' })
    .min(1, 'SUPABASE_PUBLISHABLE_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ message: 'SUPABASE_SERVICE_ROLE_KEY is required' })
    .min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('school-assets'),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().email('SENDGRID_FROM_EMAIL must be a valid email').default('no-reply@chronixedu.com'),
  // SMS sends only when this is "true" AND TERMII_API_KEY is set. Unset means off, which it is
  // by decision since 1 Oct 2026 (Termii unfunded, keys kept). See termiiService.isSmsEnabled.
  SMS_ENABLED: z.string().optional(),
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().default('ChronixEdu'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  // The web app's public address: every link the API sends starts with it (config/appUrls.ts).
  // Required, with no default: an unset value used to fall back to localhost, which nobody chose.
  APP_URL: z.string({ message: 'APP_URL is required (the web app\'s public address)' }).url('APP_URL must be a valid URL'),
  // Public base URL of this API service. Used to build the Paystack callback_url a
  // payer returns to after paying — if neither is set it falls back to localhost and
  // payers land on a dead page, so keep one of them set in every deployed environment.
  API_BASE_URL: z.string().url('API_BASE_URL must be a valid URL').optional(),
  NEXT_PUBLIC_API_URL: z.string().url('NEXT_PUBLIC_API_URL must be a valid URL').optional(),
  CORS_ORIGIN: z.string().url('CORS_ORIGIN must be a valid URL').optional(),
  SENTRY_DSN: z.string().url('SENTRY_DSN must be a valid URL').optional(),
  // Shared secret the Chronix ERP presents (X-API-Key) on /api/partner/*. Optional:
  // unset means the integration is simply off, and those routes answer 503 rather than
  // falling open. A minimum length is enforced because a short shared secret is the
  // kind of thing that gets set to "test" during a deploy and never changed.
  ERP_INTEGRATION_API_KEY: z.string().min(32, 'ERP_INTEGRATION_API_KEY must be at least 32 characters').optional(),
  // Encrypts platform admins' authenticator secrets at rest (services/totpSecretBox.ts, 3 Oct 2026).
  // Required, with no default: without it no enrolled admin could sign in, and an API that started
  // anyway would fail at the second factor instead of at boot. Keep a copy in the password manager.
  TOTP_ENCRYPTION_KEY: z
    .string({ message: 'TOTP_ENCRYPTION_KEY is required (32 random bytes, base64)' })
    .refine((v) => parseTotpKey(v) !== null, 'TOTP_ENCRYPTION_KEY must be exactly 32 bytes, base64'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data;
}
