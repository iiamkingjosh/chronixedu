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
import { redis } from '../middleware/rateLimit';

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

  // H-07: only the root admin may create another super_admin account.
  if (role === 'super_admin') {
    const rootEmail = process.env.ROOT_ADMIN_EMAIL?.toLowerCase();
    if (!rootEmail || req.user!.email?.toLowerCase() !== rootEmail) {
      return res.status(403).json({
        success: false,
        error: { code: 'ROOT_ADMIN_REQUIRED', message: 'Only the root platform admin can create super_admin accounts' },
      });
    }
  }

  // Platform super_admins (school_id === null) can create users in any school.
  // School-scoped super_admins (school_id !== null) are restricted to their own school.
  if (req.user!.role === 'super_admin' && req.user!.school_id != null && school_id && school_id !== req.user!.school_id) {
    return res.status(403).json({
      success: false,
      error: { code: 'CROSS_TENANT_FORBIDDEN', message: 'Cannot create users in another school' },
    });
  }

  const effectiveSchoolId = school_id ?? req.user!.school_id;

  // H-08: always release the pg client, even when an early return or exception occurs.
  const pg = getPgClient();
  try {
    await pg.connect();

    // Check for duplicate email scoped to this school only — prevents cross-school enumeration.
    const existing = await pg.query(
      'SELECT id FROM users WHERE email = $1 AND school_id = $2 LIMIT 1',
      [email, effectiveSchoolId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: { code: 'DUPLICATE_EMAIL', message: `A user with email "${email}" already exists in this school` },
      });
    }

    // create user in Supabase Auth using service role
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      user_metadata: { first_name, last_name, role, school_id: effectiveSchoolId, title, teacher_mode }
    });
    if (error) {
      return res.status(500).json({
        success: false,
        error: { code: 'AUTH_CREATE_FAILED', message: error.message },
      });
    }

    const userId = data?.user?.id ?? null;

    // insert into local users table
    const hashed = bcrypt.hashSync(password, 12);
    await pg.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title, teacher_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId, effectiveSchoolId, email, hashed, role, first_name || '', last_name || '', title || null, teacher_mode || 'subject']
    );

    return res.json({ success: true, data: { user_id: userId } });
  } catch (err: unknown) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  } finally {
    await pg.end();
  }
});

const loginSchema = z.object({
  email:    z.email().toLowerCase().trim(),
  password: z.string().min(1),
});

const MAX_ATTEMPTS = 5;
const MAX_IP_ATTEMPTS = 20; // higher threshold to avoid blocking shared NAT addresses
const LOCK_WINDOW_SECONDS = 15 * 60; // 15 minutes

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
    const emailKey = `login_attempts:${email.toLowerCase()}`;
    const ip = req.ip ?? 'unknown';
    const ipKey = `login_attempts_ip:${ip}`;

    // Atomic Redis-based lockout — immune to concurrent-request race conditions.
    // Falls back to no lockout in dev when Redis is unavailable.
    if (redis) {
      const [emailCount, ipCount] = await Promise.all([
        redis.get(emailKey),
        redis.get(ipKey),
      ]);
      if (emailCount !== null && parseInt(emailCount, 10) >= MAX_ATTEMPTS) {
        return res.status(429).json({
          success: false,
          error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' },
        });
      }
      if (ipCount !== null && parseInt(ipCount, 10) >= MAX_IP_ATTEMPTS) {
        return res.status(429).json({
          success: false,
          error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' },
        });
      }
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      if (redis) {
        const [emailAttempts, ipAttempts] = await Promise.all([
          redis.incr(emailKey),
          redis.incr(ipKey),
        ]);
        if (emailAttempts === 1) await redis.expire(emailKey, LOCK_WINDOW_SECONDS);
        if (ipAttempts === 1) await redis.expire(ipKey, LOCK_WINDOW_SECONDS);
        if (emailAttempts >= MAX_ATTEMPTS || ipAttempts >= MAX_IP_ATTEMPTS) {
          return res.status(429).json({
            success: false,
            error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' },
          });
        }
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email or password' },
        });
      }
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
      });
    }

    const userId = data.user.id;

    // H-08: always release the pg client, even when an early return or exception occurs.
    const pg = getPgClient();
    let local: { id: string; school_id: string; role: string; title: string; email: string; first_name: string; last_name: string; is_active: boolean } | undefined;
    try {
      await pg.connect();
      const r = await pg.query(
        `SELECT id, school_id, role, title, email, first_name, last_name, is_active FROM users WHERE id = $1`,
        [userId]
      );
      local = r.rows[0];
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
      await pg.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [local.id]);
    } finally {
      await pg.end();
    }

    // Clear lockout counters on successful login.
    if (redis) await Promise.all([redis.del(emailKey), redis.del(ipKey)]);

    const payload = {
      user_id: local.id,
      school_id: local.school_id,
      role: local.role,
      email: local.email,
      title: local.title,
      first_name: local.first_name,
      last_name: local.last_name,
    };

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is not set');
    const token = jwt.sign(payload, jwtSecret, { expiresIn: '1h' });
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
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_OR_EXPIRED_TOKEN', message: 'This reset link is invalid or has expired. Please request a new one.' },
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
