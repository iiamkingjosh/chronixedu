import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { isAuthSessionMissingError, type User as SupabaseUser } from '@supabase/supabase-js';
import { supabase, supabaseAdmin } from '../supabaseClient';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import pool, { resolveSsl } from '../db/client';
import { verifyToken, requireRole } from '../middleware/auth';
import { findUserByEmail, getPasswordHashById, changeOwnPassword, endSessionsBeforeNow } from '../db/queries/users';
import { logAudit } from '../db/queries/auditLog';
import { redis, bestEffort } from '../middleware/rateLimit';
import { clientIp } from '../middleware/clientIp';
import { logger } from '../config/logger';
import { isLockedOut, recordFailedAttempt, clearFailedAttempts } from '../services/loginLockout';
import { signInAndRevoke } from '../services/passwordCheck';
import { judgeResetToken } from '../services/resetLink';
import { resetPasswordRedirect } from '../config/appUrls';
import { sendEmail } from '../services/emailService';
import { matchTotpStep, totpStep } from '../services/totp';
import {
  isTwoFactorActive, readTotpState, readTotpSecret, isLocked, acceptTotpStep, recordTotpFailure,
  consumeRecoveryCode, clearTotpFailures, unusedRecoveryCodeCount, TOTP_LOCK_MINUTES,
} from '../db/queries/twoFactorStore';
import {
  createLoginChallenge, findLiveChallenge, recordChallengeFailure, spendChallenge,
  CHALLENGE_TTL_SECONDS, CHALLENGE_MAX_ATTEMPTS,
} from '../db/queries/loginChallenges';
import { logPlatformAudit } from '../db/queries/platformAudit';
import { MUST_CHANGE_PASSWORD_CACHE_SECONDS } from '../config/cacheTimes';
import { PASSWORD_RECENTLY_USED } from '../services/passwordReuse';

const router = express.Router();

/**
 * The login connection — the one place the database is reached on behalf of an
 * UNAUTHENTICATED caller. Used by POST /login and nothing else, so that C-4a can give it
 * its own column-scoped role (docs/c4a/grants.sql): if a flaw on this path shares the app
 * role it reaches scores, payments and audit rows; with its own role it reaches the ten
 * user columns and one schools column that login actually reads.
 *
 * TLS resolved through resolveSsl() like the pool. It was `new Client({ connectionString })`
 * with no `ssl` option, so its TLS was whatever the URL implied, verified or not — while
 * the boot log's `pg_tls_verified` described only the pool. Resolved once at load, so the
 * boot log states this connection's TLS too (connection: 'login').
 */
const LOGIN_DATABASE_URL = process.env.DATABASE_URL || '';
const LOGIN_SSL = resolveSsl(LOGIN_DATABASE_URL, 'login');

function getLoginClient() {
  return new Client({ connectionString: LOGIN_DATABASE_URL, ssl: LOGIN_SSL });
}

const createUserSchema = z.object({
  email:        z.email().toLowerCase().trim(),
  password:     z.string().min(8),
  role:         z.enum(['super_admin', 'principal', 'registrar', 'bursar', 'teacher', 'parent', 'student']),
  school_id:    z.uuid().optional(),
  first_name:   z.string().min(1).max(80).trim().optional(),
  last_name:    z.string().min(1).max(80).trim().optional(),
  title:        z.string().max(20).trim().optional(),
  // Must match the chronixedu_teacher_mode enum in migration 001. This previously
  // read ['subject','form']; 'form' is not a valid enum value, so any caller passing
  // it cleared validation and then failed at the INSERT.
  teacher_mode: z.enum(['subject', 'class']).optional(),
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

  // On the app pool, not the login connection: this route sits behind super_admin auth,
  // and leaving it on the login client would have forced the login role to hold INSERT on
  // users. Two independent statements, no transaction, so the move changes no behaviour.
  try {
    // Check for duplicate email scoped to this school only — prevents cross-school enumeration.
    const existing = await pool.query(
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

    // insert into local users table. A platform admin made from now on must enrol in two-factor
    // (migration 058); everyone else carries NULL, because it does not apply to them.
    const hashed = bcrypt.hashSync(password, 12);
    await pool.query(
      `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title, teacher_mode, two_factor_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [userId, effectiveSchoolId, email, hashed, role, first_name || '', last_name || '', title || null, teacher_mode || 'subject',
        role === 'super_admin' ? true : null]
    );

    return res.json({ success: true, data: { user_id: userId } });
  } catch (err: unknown) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
});

interface LocalUser {
  id: string; school_id: string; role: string; title: string; email: string; first_name: string;
  last_name: string; is_active: boolean; support_code: string; must_change_password: boolean;
}
const LOCAL_USER_COLUMNS = 'id, school_id, role, title, email, first_name, last_name, is_active, support_code, must_change_password';

/**
 * The end of every successful sign-in, on the login connection: stamp last_login_at, read the
 * school's tier, sign the app's own JWT. `extraClaims` carries `second_factor` after the 2FA step.
 */
async function issueSession(pg: Client, local: LocalUser, extraClaims: Record<string, unknown> = {}) {
  await pg.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [local.id]);
  let subscriptionTier: string | null = null;
  if (local.school_id) {
    const schoolResult = await pg.query<{ subscription_tier: string | null }>(
      `SELECT subscription_tier FROM schools WHERE id = $1`,
      [local.school_id]
    );
    subscriptionTier = schoolResult.rows[0]?.subscription_tier ?? null;
  }
  const payload = {
    user_id: local.id,
    school_id: local.school_id,
    role: local.role,
    email: local.email,
    title: local.title,
    first_name: local.first_name,
    last_name: local.last_name,
    subscription_tier: subscriptionTier,
    support_code: local.support_code,
    must_change_password: local.must_change_password,
    ...extraClaims,
  };
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is not set');
  return { access_token: jwt.sign(payload, jwtSecret, { expiresIn: '1h' }), user: payload };
}

const loginSchema = z.object({
  email:    z.email().toLowerCase().trim(),
  password: z.string().min(1),
});

router.post('/login', async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Valid email and password are required.' },
    });
  }
  const { email, password } = parsed.data;

  try {
    const ip = clientIp(req) ?? 'unknown';

    // The per-email and per-address lockout (services/loginLockout.ts), shared with every other
    // place a person proves who they are. No lockout in dev when Redis is unset, and none while
    // Redis is DOWN: each call is best-effort (SECURITY.md Round 19, decided: fail open). A Redis
    // failure is logged as login_lockout_unavailable and the login proceeds on the password check
    // alone; it is never turned into a 500, and never into a lockout.
    if (await isLockedOut(email, ip)) {
      return res.status(429).json({
        success: false,
        error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' },
      });
    }

    // Checked through Supabase, and the Supabase session that creates is revoked at once
    // (services/passwordCheck.ts, SECURITY.md Round 35): the app runs on its own JWT, and every
    // sign-in used to leave behind a session that never expired.
    const userId = await signInAndRevoke(email, password);

    if (!userId) {
      const { counted, locked } = await recordFailedAttempt(email, ip);
      if (locked) {
        return res.status(429).json({
          success: false,
          error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' },
        });
      }
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: counted ? 'Incorrect email or password' : 'Invalid credentials.' },
      });
    }

    // H-08: always release the pg client, even when an early return or exception occurs.
    const pg = getLoginClient();
    let local: LocalUser | undefined;
    let session: Awaited<ReturnType<typeof issueSession>>;
    try {
      await pg.connect();
      const r = await pg.query<LocalUser>(`SELECT ${LOCAL_USER_COLUMNS} FROM users WHERE id = $1`, [userId]);
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
      // Two-factor, commit 3: a platform admin who has switched it on gets no token for the password
      // alone, only a challenge for POST /login/verify (migration 057). The lockout counters are NOT
      // cleared here: clearing them on a correct password would let someone who has the password
      // reset the count before each round of code guesses. An admin who has not enrolled signs in
      // as before (enrolling is optional, decided 3 Oct 2026).
      if (local.role === 'super_admin' && await isTwoFactorActive(local.id, pg)) {
        const challenge = await createLoginChallenge(pg, local.id, clientIp(req) ?? null);
        return res.set({ 'Cache-Control': 'no-store' }).json({
          success: true,
          data: { two_factor_required: true, challenge, expires_in: CHALLENGE_TTL_SECONDS },
        });
      }
      session = await issueSession(pg, local);
    } finally {
      await pg.end();
    }

    // Clear lockout counters on successful login. Best-effort: a correct password is
    // never refused because the counters could not be cleared.
    await clearFailedAttempts(email, ip);
    return res.json({ success: true, data: session });
  } catch (err: unknown) {
    return next(err);
  }
});

// ── POST /login/verify ─────────────────────────────────────────────────────────
// The second step of a platform admin's sign-in (2FA commit 3, migration 057). Takes the challenge
// from POST /login and either an authenticator code or a recovery code. On the login connection,
// never the app pool: the caller is not signed in yet (decision d, docs/c4a/grants.sql).
//
// Every wrong code counts three times over:
//  - against the challenge, which dies after CHALLENGE_MAX_ATTEMPTS;
//  - against the account's consecutive-failure counter (user_totp.failed_attempts). It is per
//    ACCOUNT, survives new challenges, and only a right code clears it. A per-challenge counter would
//    reset each time someone with the password asked for a new challenge, so the lock would never
//    fire. At TOTP_LOCK_AFTER the factor locks for TOTP_LOCK_MINUTES, held in the database because
//    Redis fails open (decision c);
//  - against the per-email and per-address sign-in lockout, and rl:login, which covers this route.
const verifySchema = z
  .object({
    challenge: z.string().min(20).max(100),
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app').optional(),
    recovery_code: z.string().trim().min(16).max(40).optional(),
  })
  .refine((d) => (d.code ? 1 : 0) + (d.recovery_code ? 1 : 0) === 1, {
    message: 'Enter a code from your authenticator app, or one recovery code',
    path: ['code'],
  });

function signInAgain(res: Response, code: string, message: string) {
  return res.status(401).json({ success: false, error: { code, message } });
}

router.post('/login/verify', async (req: Request, res: Response, next: NextFunction) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });
  }
  const { challenge: raw, code, recovery_code } = parsed.data;
  const ip = clientIp(req) ?? 'unknown';

  try {
    const pg = getLoginClient();
    let local: LocalUser | undefined;
    let session: Awaited<ReturnType<typeof issueSession>>;
    let recovery: { recovery_codes_left: number; notice_email: string } | undefined;
    try {
      await pg.connect();
      const challenge = await findLiveChallenge(pg, raw);
      if (!challenge) {
        return signInAgain(res, 'SIGN_IN_EXPIRED', 'This sign-in has expired. Enter your password again.');
      }
      const r = await pg.query<LocalUser>(`SELECT ${LOCAL_USER_COLUMNS} FROM users WHERE id = $1`, [challenge.userId]);
      local = r.rows[0];
      if (!local || !local.is_active || local.role !== 'super_admin') {
        return signInAgain(res, 'SIGN_IN_EXPIRED', 'This sign-in has expired. Enter your password again.');
      }
      if (await isLockedOut(local.email, ip)) {
        return res.status(429).json({ success: false, error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again in 15 minutes.' } });
      }
      const state = await readTotpState(local.id, pg);
      if (!state?.activatedAt) {
        // Two-factor was switched off (break-glass) since the password step.
        return signInAgain(res, 'SIGN_IN_EXPIRED', 'This sign-in has expired. Enter your password again.');
      }
      if (isLocked(state)) {
        return res.status(423).json({ success: false, error: { code: 'TWO_FACTOR_LOCKED', message: `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.` } });
      }

      let accepted = false;
      let stepOffset: number | null = null;
      if (code) {
        const stored = await readTotpSecret(local.id, pg);
        const now = Date.now() / 1000;
        const step = stored ? matchTotpStep(stored.secret, code, now) : null;
        if (step !== null && await acceptTotpStep(local.id, step, pg)) {
          accepted = true;
          stepOffset = step - totpStep(now);
        }
      } else if (recovery_code && await consumeRecoveryCode(local.id, recovery_code, pg)) {
        accepted = true;
        await clearTotpFailures(local.id, pg);
      }

      if (!accepted) {
        const attempts = await recordChallengeFailure(pg, challenge.id);
        const { failedAttempts, locked } = await recordTotpFailure(local.id, pg);
        await recordFailedAttempt(local.email, ip);
        if (locked) {
          logger.error('two_factor_locked', { user_id: local.id, failed_attempts: failedAttempts, route: 'sign-in' });
          await logPlatformAudit({
            adminId: local.id, actionType: 'TWO_FACTOR_LOCKED', targetUserId: local.id,
            metadata: { failed_attempts: failedAttempts, route: 'sign-in' }, ipAddress: clientIp(req) ?? null,
          }, pg);
          return res.status(423).json({ success: false, error: { code: 'TWO_FACTOR_LOCKED', message: `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.` } });
        }
        if (attempts >= CHALLENGE_MAX_ATTEMPTS) {
          return signInAgain(res, 'SIGN_IN_EXPIRED', 'Too many wrong codes for this sign-in. Enter your password again.');
        }
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CODE', message: code ? 'That code is not right, or it has already been used. Wait for the next one.' : 'That recovery code is not right, or it has already been used.' },
        });
      }

      if (!(await spendChallenge(pg, challenge.id))) {
        return signInAgain(res, 'SIGN_IN_EXPIRED', 'This sign-in has expired. Enter your password again.');
      }

      if (stepOffset !== null) {
        // Which step was accepted: -1, 0 or +1. If the server's clock drifts, the offsets slide to
        // one edge days before codes start failing; the log is the warning (reviewer, 3 Oct 2026).
        logger.info('totp_code_accepted', { user_id: local.id, step_offset: stepOffset, route: 'sign-in' });
      }
      if (recovery_code) {
        const left = await unusedRecoveryCodeCount(local.id, pg);
        await logPlatformAudit({
          adminId: local.id, actionType: 'RECOVERY_CODE_USED', targetUserId: local.id,
          metadata: { recovery_codes_left: left }, ipAddress: clientIp(req) ?? null,
        }, pg);
        // Someone spending a recovery code has usually lost their phone, which is exactly when a
        // silent send failure matters: "sent" means SendGrid accepted it, so the outcome is read and
        // told to them, and anything else is alerted.
        const notice = await sendEmail(
          local.email,
          'A recovery code was used on your Chronix Edu account',
          `A recovery code was just used to sign in to your Chronix Edu platform-admin account.\n\n` +
          `You have ${left} recovery code${left === 1 ? '' : 's'} left. Once you have your authenticator again, ` +
          `make a new set at Administration > Two-factor Sign-in.\n\n` +
          `If this was not you, change your password now and contact Chronix.`
        );
        if (notice !== 'sent') logger.error('recovery_code_notice_not_sent', { user_id: local.id, outcome: notice });
        recovery = { recovery_codes_left: left, notice_email: notice };
      }
      session = await issueSession(pg, local, { second_factor: code ? 'totp' : 'recovery_code' });
    } finally {
      await pg.end();
    }

    // Cleared only now, after the second factor, never at the password step.
    await clearFailedAttempts(local.email, ip);
    return res.set({ 'Cache-Control': 'no-store' }).json({ success: true, data: { ...session, ...(recovery ? { recovery } : {}) } });
  } catch (err: unknown) {
    return next(err);
  }
});

// Requires SEED_SECRET to be explicitly configured — if it's unset, the route
// isn't registered at all, so there's no fail-open path where a missing secret
// makes `req.headers['x-seed-secret'] !== process.env.SEED_SECRET` pass by
// both sides being undefined.
if (process.env.NODE_ENV !== 'production' && process.env.SEED_SECRET) {
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

    // App pool, not the login connection — see create-user above.
    try {
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

      // Upsert the local users row — safe to run whether the row exists or not. A new platform admin
      // must enrol in two-factor (migration 058); an existing one keeps what was decided for it.
      const hashed = bcrypt.hashSync(password, 12);
      await pool.query(
        `INSERT INTO users (id, school_id, email, password_hash, role, first_name, last_name, title, two_factor_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE
           SET email         = EXCLUDED.email,
               password_hash = EXCLUDED.password_hash,
               role          = EXCLUDED.role,
               first_name    = EXCLUDED.first_name,
               last_name     = EXCLUDED.last_name,
               title         = EXCLUDED.title,
               school_id     = COALESCE(users.school_id, EXCLUDED.school_id),
               two_factor_required = CASE WHEN EXCLUDED.role = 'super_admin'
                                          THEN COALESCE(users.two_factor_required, true) END`,
        [userId, school_id || null, email, hashed, role, first_name, last_name, title || null,
          role === 'super_admin' ? true : null]
      );

      return res.json({ success: true, data: { user_id: userId, reused_auth: !!existingAuthUser } });
    } catch (err: unknown) {
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal server error' },
      });
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


/**
 * Sends the reset email after the response has gone. Never throws: a failure, returned or
 * thrown, is logged with the user id. The address is not logged.
 */
async function sendResetEmail(userId: string, email: string, redirectTo: string): Promise<void> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      logger.error('password_reset_email_failed', { user_id: userId, status: error.status, error: error.message });
      return;
    }
    logger.info('password_reset_email_accepted', { user_id: userId });
  } catch (err) {
    logger.error('password_reset_email_failed', { user_id: userId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Request a password-reset email. Every well-formed request gets the same 200 and the same
 * body — unknown address, known address, send succeeded, send failed — and gets it BEFORE any
 * email is attempted, so neither the answer nor the time it takes says whether an account
 * exists. It used to answer 500 RESET_EMAIL_FAILED, with Supabase's own error text, for a known
 * address whose send failed: an enumeration oracle exactly when mail was down, as on 1 Oct 2026.
 * And only a known address waited on the Supabase round trip, which is a timing oracle too.
 */
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

    const redirectTo = redirect_to ?? resetPasswordRedirect();

    const local = await findUserByEmail(email);

    res.json({
      success: true,
      data: {
        message:
          'If an account exists for that email, a password reset link has been sent.',
      },
    });

    // After the answer, so the known and unknown branches take the same time to respond.
    if (local) void sendResetEmail(local.id, email, redirectTo);
  } catch (err) {
    return next(err);
  }
}

router.post('/forgot-password', handleForgotPassword);
router.post('/reset-password', handleForgotPassword);

const resetLandingSchema = z.object({
  outcome: z.enum(['no_parameters', 'supabase_error', 'unsupported_format', 'token_refused']),
  error_code: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).optional(),
});

/**
 * The reset page reports a landing it could not use (2 Oct 2026). Every such failure used to happen
 * only in the browser and leave no trace on any server, on the one path by which staff and parents
 * set a password since H2. Public, because the person has no session; the /api/auth limiter applies
 * (5 a minute). It takes an outcome and Supabase's error code: no address, no token.
 *
 * A link the page cannot read (`unsupported_format`) means nobody can reset a password, so it alerts.
 * The others are routine (a used or expired link, a page opened without one, a session that lapsed
 * before the form was sent), so they are warnings: visible and countable, not paged.
 */
router.post('/reset-landing', (req: Request, res: Response) => {
  const parsed = resetLandingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Unknown reset-landing outcome' } });
  }
  const { outcome, error_code } = parsed.data;
  if (outcome === 'unsupported_format') logger.error('password_reset_link_unreadable', { outcome, error_code });
  else logger.warn('password_reset_landing_failed', { outcome, error_code });
  return res.status(204).end();
});

/**
 * Records a person setting their own password. A school's user goes to audit_logs; anyone without a
 * school (a platform admin) goes to platform_audit_logs. Until 5 Oct 2026 only the first was written,
 * so a platform admin's reset or change left no record at all; the root admin's reset that day was
 * the first one seen.
 */
async function auditOwnPasswordChange(
  user: { id: string; school_id: string | null },
  actionType: 'PASSWORD_RESET_COMPLETE' | 'PASSWORD_SELF_CHANGE',
  ipAddress: string | null,
): Promise<void> {
  if (user.school_id) {
    await logAudit({ ipAddress, schoolId: user.school_id, userId: user.id, actionType, entity: 'users', entityId: user.id });
    return;
  }
  await logPlatformAudit({ adminId: user.id, actionType, targetUserId: user.id, ipAddress });
}

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

    // Only a reset link's own session, opened within the hour, may set a password without the current
    // one (services/resetLink.ts, Round 35). Any session's token used to do, and sign-in left sessions
    // that never expired: each was a standing password reset that bypassed sign-in. Refused with the
    // same answer as an expired link; the reason is logged, never the token.
    const verdict = judgeResetToken(access_token);
    if (!verdict.ok) {
      logger.warn('password_reset_token_refused', { reason: verdict.reason, auth_user_id: userData.user.id });
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
      // The link worked: Supabase holds a login for this address, and no app account sits behind it.
      // It used to answer "invalid or expired" and log nothing, which sent the person back to
      // request another link that would fail the same way. Not an enumeration oracle: reaching
      // here takes a valid recovery token, which only the mailbox's owner holds.
      logger.error('password_reset_no_local_account', { auth_user_id: userData.user.id });
      return res.status(401).json({
        success: false,
        error: { code: 'NO_APP_ACCOUNT', message: 'This login has no Chronix Edu account. Your link is fine: please contact your school administrator.' },
      });
    }

    // One transaction (changeOwnPassword): the reuse rule, the history, our hash and Supabase's. A
    // refusal changes nothing, so the reset link still works for another try within its hour.
    const changed = await changeOwnPassword(local.id, password, async () => {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userData.user.id, { password });
      return { ok: !error, error: error?.message };
    });
    if (!changed.ok) {
      if (changed.error === 'recently_used') {
        return res.status(400).json({ success: false, error: { ...PASSWORD_RECENTLY_USED } });
      }
      return res.status(400).json({
        success: false,
        error: { code: 'PASSWORD_UPDATE_FAILED', message: changed.error },
      });
    }

    // A reset ends what came before it (Round 35):
    //  - every Supabase session of the account, this reset link's included, so the link works once;
    //  - every app session (users.sessions_valid_after; enforced for platform admins' tokens today).
    // A failed revocation does not undo the reset: the password has changed. It is alerted.
    await endSessionsBeforeNow(local.id);
    try {
      const { error: revokeError } = await supabaseAdmin.auth.admin.signOut(access_token, 'global');
      if (revokeError && isAuthSessionMissingError(revokeError)) {
        // Setting the password through the admin API has already ended every Supabase session of
        // the account, this link's included, so the sign-out finds its session gone ("Auth session
        // missing!"). Gone is what this step is for. Alerting it raised CHRONIXEDU-API-5 on a correct
        // reset (5 Oct 2026); the live-Auth test in tests/passwordResetSessions.test.ts holds the
        // premise, so a Supabase that stopped doing it would fail CI, not go quiet here.
        logger.info('password_reset_sessions_already_ended', { user_id: local.id });
      } else if (revokeError) {
        throw revokeError;
      }
    } catch (err) {
      logger.error('password_reset_sessions_not_revoked', {
        user_id: local.id,
        error: err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err),
      });
    }

    // Immediately clear the must-change-password cache so requirePasswordChanged
    // unblocks this user on their very next request, rather than waiting out the
    // 5-minute cache TTL. Best-effort, like every Redis call on a request path (Round 19).
    const r = redis;
    if (r) {
      await bestEffort('must_change_password_cache_unavailable',
        () => r.set(`must_change_password:${local.id}`, '0', 'EX', MUST_CHANGE_PASSWORD_CACHE_SECONDS));
    }

    await auditOwnPasswordChange(local, 'PASSWORD_RESET_COMPLETE', clientIp(req) ?? null);

    return res.json({
      success: true,
      data: { message: 'Your password has been updated. You can now sign in.' },
    });
  } catch (err) {
    return next(err);
  }
});

const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, 'Current password is required'),
    new_password: z.string().min(8, 'Password must be at least 8 characters'),
  })
  .refine((d) => d.current_password !== d.new_password, {
    message: 'New password must be different from your current password',
    path: ['new_password'],
  });

/** Self-service password change for an already-logged-in user — covers both
 *  "change the temp password shown once on first login" and any later
 *  voluntary change. Requires the current password (proves the caller, not
 *  just an unattended open session, is making this change). */
router.post('/change-password', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
      });
    }
    const { current_password, new_password } = parsed.data;
    const userId = req.user!.user_id;

    // A wrong current password is a mistake in the form, not an expired session. It was a 401, which
    // apiFetch treats as a lapsed sign-in: the person was signed out and never saw this message.
    const currentHash = await getPasswordHashById(userId);
    if (!currentHash || !bcrypt.compareSync(current_password, currentHash)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect' },
      });
    }

    const result = await changeOwnPassword(userId, new_password, async () => {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: new_password });
      return { ok: !error, error: error?.message };
    });

    if (!result.ok) {
      if (result.error === 'recently_used') {
        return res.status(400).json({ success: false, error: { ...PASSWORD_RECENTLY_USED } });
      }
      if (result.error === 'not_found') {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      }
      return res.status(500).json({ success: false, error: { code: 'PASSWORD_UPDATE_FAILED', message: result.error } });
    }

    // Immediately clear the must-change-password cache so requirePasswordChanged
    // unblocks this user on their very next request, rather than waiting out the
    // 5-minute cache TTL. Best-effort, like every Redis call on a request path (Round 19).
    const r = redis;
    if (r) {
      await bestEffort('must_change_password_cache_unavailable',
        () => r.set(`must_change_password:${userId}`, '0', 'EX', MUST_CHANGE_PASSWORD_CACHE_SECONDS));
    }

    await auditOwnPasswordChange({ id: userId, school_id: req.user!.school_id ?? null }, 'PASSWORD_SELF_CHANGE', clientIp(req) ?? null);

    return res.json({ success: true, data: { message: 'Password updated.' } });
  } catch (err) {
    return next(err);
  }
});

export default router;
