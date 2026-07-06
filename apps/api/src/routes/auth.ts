import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { supabase, supabaseAdmin } from '../supabaseClient';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { verifyToken, requireRole } from '../middleware/auth';
import { findUserByEmail, updatePasswordHash } from '../db/queries/users';
import { logAudit } from '../db/queries/auditLog';
import { logger } from '../config/logger';

const router = express.Router();

function getPgClient() {
  const conn = process.env.DATABASE_URL || '';
  return new Client({ connectionString: conn });
}

const createUserSchema = z.object({
  email:        z.email().toLowerCase().trim(),
  password:     z.string().min(8),
  role:         z.enum(['super_admin', 'principal', 'registrar', 'bursar', 'teacher', 'parent', 'student']),
  school_id:    z.uuid().optional(),
  first_name:   z.string().min(1).max(80).trim().optional(),
  last_name:    z.string().min(1).max(80).trim().optional(),
  title:        z.string().max(20).trim().optional(),
  teacher_mode: z.enum(['subject', 'form']).optional(),
});

router.post('/create-user', verifyToken, requireRole('super_admin'), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
    });
  }
  const { email, password, role, school_id, first_name, last_name, title, teacher_mode } = parsed.data;

  try {
    // create user in Supabase Auth using service role
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      user_metadata: { first_name, last_name, role, school_id, title, teacher_mode }
    });
    if (error) {
      return res.status(500).json({
        success: false,
        error: { code: 'AUTH_CREATE_FAILED', message: error.message },
      });
    }

    const userId = data?.user?.id ?? null;

    // insert into local users table
    const pg = getPgClient();
    await pg.connect();
    const hashed = bcrypt.hashSync(password, 12);
    await pg.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title, teacher_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId, school_id || null, email, hashed, role, first_name || '', last_name || '', title || null, teacher_mode || 'subject']
    );
    await pg.end();

    return res.json({ success: true, data: { user_id: userId } });
  } catch (err: unknown) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal server error' },
    });
  }
});

const loginSchema = z.object({
  email:    z.email().toLowerCase().trim(),
  password: z.string().min(1),
});

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Valid email and password are required.' },
    });
  }
  const { email, password } = parsed.data;

  try {
    // Check account lockout before touching Supabase Auth
    const pg = getPgClient();
    await pg.connect();
    const lockRow = await pg.query<{
      id: string;
      failed_login_attempts: number;
      locked_until: Date | null;
    }>(
      `SELECT id, failed_login_attempts, locked_until FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );
    await pg.end();

    const lockRecord = lockRow.rows[0];
    if (lockRecord?.locked_until && lockRecord.locked_until > new Date()) {
      const until = lockRecord.locked_until.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return res.status(423).json({
        success: false,
        error: { code: 'ACCOUNT_LOCKED', message: `Account locked until ${until}. Reset your password or try again later.` },
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    logger.debug('login_auth_result', { error: error?.message ?? null, userId: data?.user?.id ?? null });

    if (error) {
      // Increment failed attempt counter on the local user record
      if (lockRecord) {
        const attempts = (lockRecord.failed_login_attempts ?? 0) + 1;
        const lockedUntil = attempts >= MAX_ATTEMPTS
          ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
          : null;
        const pg2 = getPgClient();
        await pg2.connect();
        await pg2.query(
          `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
          [attempts, lockedUntil, lockRecord.id]
        );
        await pg2.end();

        if (lockedUntil) {
          return res.status(423).json({
            success: false,
            error: { code: 'ACCOUNT_LOCKED', message: `Too many failed attempts. Account locked for ${LOCK_MINUTES} minutes.` },
          });
        }
        const remaining = MAX_ATTEMPTS - attempts;
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: `Invalid credentials. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` },
        });
      }
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
      });
    }

    const userId = data.user.id;

    // fetch local user record by Supabase UUID — not by email, which may be shared across roles
    const pg3 = getPgClient();
    await pg3.connect();
    const r = await pg3.query(
      `SELECT id, school_id, role, title, email, first_name, last_name, is_active FROM users WHERE id = $1`,
      [userId]
    );
    await pg3.end();
    const local = r.rows[0];
    logger.debug('login_local_user_lookup', { found: !!local, userId });
    if (!local) {
      return res.status(500).json({
        success: false,
        error: { code: 'USER_RECORD_MISSING', message: 'Local user record missing. Contact support.' },
      });
    }
    if (!local.is_active) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCOUNT_SUSPENDED', message: 'This account has been suspended. Contact your administrator.' },
      });
    }

    // Successful login — reset lockout counter and update last login
    const pg4 = getPgClient();
    await pg4.connect();
    await pg4.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [local.id]
    );
    await pg4.end();

    const payload = {
      user_id: local.id,
      school_id: local.school_id,
      role: local.role,
      email: local.email,
      title: local.title,
      first_name: local.first_name,
      last_name: local.last_name,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET || '', { expiresIn: '1h' });
    return res.json({ success: true, data: { access_token: token, user: payload } });
  } catch (err: unknown) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal server error' },
    });
  }
});

if (process.env.NODE_ENV === 'development') {
  router.post('/seed-test-user', async (req, res) => {
    if (req.headers['x-seed-secret'] !== process.env.SEED_SECRET) {
      return res.status(404).json({ success: false });
    }
    const { email, password, role, first_name, last_name, title, school_id } = req.body;
    if (!email || !password || !role || !first_name || !last_name) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Missing required fields: email, password, role, first_name, last_name' },
      });
    }

    const pg = getPgClient();
    try {
      await pg.connect();

      // Check whether a Supabase Auth user with this email already exists
      const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
      const existingAuthUser = listData?.users?.find((u: SupabaseUser) => u.email === email);

      let userId: string;

      if (existingAuthUser) {
        // Reuse the existing Auth identity — do not delete or recreate it
        userId = existingAuthUser.id;
      } else {
        // Create a new Supabase Auth user — its UUID becomes the primary key
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
        if (authError) {
          return res.status(500).json({
            success: false,
            error: { code: 'AUTH_CREATE_FAILED', message: `Supabase Auth create failed: ${authError.message}` },
          });
        }
        userId = authData.user.id;
      }

      // Upsert the local users row — safe to run whether the row exists or not
      const hashed = bcrypt.hashSync(password, 12);
      await pg.query(
        `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
           SET email         = EXCLUDED.email,
               password_hash = EXCLUDED.password_hash,
               role          = EXCLUDED.role,
               first_name    = EXCLUDED.first_name,
               last_name     = EXCLUDED.last_name,
               title         = EXCLUDED.title,
               school_id     = COALESCE(users.school_id, EXCLUDED.school_id)`,
        [userId, school_id || null, email, hashed, role, first_name, last_name, title || null]
      );

      return res.json({ success: true, data: { user_id: userId, reused_auth: !!existingAuthUser } });
    } catch (err: unknown) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal server error' },
      });
    } finally {
      await pg.end();
    }
  });

  router.get('/test-role', verifyToken, requireRole('principal'), (req, res) => {
    return res.json({ success: true, data: { role: req.user?.role } });
  });
}

const ALLOWED_REDIRECT_ORIGINS = [
  'https://chronixeduweb-production.up.railway.app',
  'https://edu.chronixtechnology.com',
  'http://localhost:3000',
];

const forgotPasswordSchema = z.object({
  email: z.string().email(),
  redirect_to: z.string().url().optional(),
});

const confirmResetSchema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirm_password: z.string(),
    access_token: z.string().min(1, 'Reset token is missing or invalid'),
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

function defaultResetRedirect(): string {
  const base = process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/reset-password`;
}

/** Request a password-reset email (always returns success to avoid email enumeration). */
async function handleForgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
      });
    }

    const { email, redirect_to } = parsed.data;

    if (redirect_to) {
      const parsed_url = new URL(redirect_to);
      const isAllowed = ALLOWED_REDIRECT_ORIGINS.some(origin => parsed_url.origin === origin);
      if (!isAllowed) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_REDIRECT', message: 'Redirect URL not allowed' },
        });
      }
    }

    const redirectTo = redirect_to ?? defaultResetRedirect();

    const local = await findUserByEmail(email);
    if (local) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) {
        return res.status(500).json({
          success: false,
          error: { code: 'RESET_EMAIL_FAILED', message: error.message },
        });
      }
    }

    return res.json({
      success: true,
      data: {
        message:
          'If an account exists for that email, a password reset link has been sent.',
      },
    });
  } catch (err) {
    return next(err);
  }
}

router.post('/forgot-password', handleForgotPassword);
router.post('/reset-password', handleForgotPassword);

/** Complete password reset using the recovery access_token from the email link. */
router.post('/confirm-reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = confirmResetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() },
      });
    }

    const { password, access_token } = parsed.data;

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(access_token);
    if (userError || !userData.user?.email) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'This reset link is invalid or has expired. Please request a new one.',
        },
      });
    }

    const email = userData.user.email;
    const local = await findUserByEmail(email);
    if (!local) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND', message: 'No account found for this reset link.' },
      });
    }

    const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(
      userData.user.id,
      { password }
    );
    if (updateAuthError) {
      return res.status(400).json({
        success: false,
        error: { code: 'PASSWORD_UPDATE_FAILED', message: updateAuthError.message },
      });
    }

    const passwordHash = bcrypt.hashSync(password, 12);
    await updatePasswordHash(email, passwordHash);

    if (local.school_id) {
      await logAudit({
        schoolId: local.school_id,
        userId: local.id,
        actionType: 'PASSWORD_RESET_COMPLETE',
        entity: 'users',
        entityId: local.id,
      });
    }

    return res.json({
      success: true,
      data: { message: 'Your password has been updated. You can now sign in.' },
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
