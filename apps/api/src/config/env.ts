import { z } from 'zod';

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
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().default('ChronixEdu'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  APP_URL: z.string().url('APP_URL must be a valid URL').optional(),
  NEXTAUTH_URL: z.string().url('NEXTAUTH_URL must be a valid URL').optional(),
  NEXT_PUBLIC_API_URL: z.string().url('NEXT_PUBLIC_API_URL must be a valid URL').optional(),
  CORS_ORIGIN: z.string().url('CORS_ORIGIN must be a valid URL').optional(),
  SENTRY_DSN: z.string().url('SENTRY_DSN must be a valid URL').optional(),
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
