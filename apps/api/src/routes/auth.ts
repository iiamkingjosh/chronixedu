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

router.post('/create-user', verifyToken, requireRole('super_admin'), async (req, res) => {
  const { email, password, role, school_id, first_name, last_name, title, teacher_mode } = req.body;
  if (!email || !password || !role) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Missing fields: email, password, role' },
    });
  }

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
    const hashed = bcrypt.hashSync(password, 10);
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

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Missing credentials' },
    });
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    logger.debug('login_auth_result', { error: error?.message ?? null, userId: data?.user?.id ?? null });
    if (error) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: error.message },
      });
    }

    const userId = data?.user?.id || null;

    // fetch local user record
    const pg = getPgClient();
    await pg.connect();
    const r = await pg.query('SELECT id, school_id, role, title, email, password_hash FROM users WHERE email = $1', [email]);
    await pg.end();
    const local = r.rows[0];
    logger.debug('login_local_user_lookup', { found: !!local, email });
    if (!local) {
      return res.status(500).json({
        success: false,
        error: { code: 'USER_RECORD_MISSING', message: 'Local user record missing' },
      });
    }

    const passwordMatch = bcrypt.compareSync(password, local.password_hash);
    logger.debug('login_password_match', { match: passwordMatch });

    if (passwordMatch) {
      const pg2 = getPgClient();
      await pg2.connect();
      await pg2.query('UPDATE users SET last_login_at = now() WHERE id = $1', [local.id]);
      await pg2.end();
    }

    const payload = {
      user_id: userId || local.id,
      school_id: local.school_id,
      role: local.role,
      email: local.email,
      title: local.title
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
      const hashed = bcrypt.hashSync(password, 10);
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

    const passwordHash = bcrypt.hashSync(password, 10);
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
