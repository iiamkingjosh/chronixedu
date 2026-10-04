import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { verifyToken, requireRole } from '../middleware/auth';
import { clientIp } from '../middleware/clientIp';
import { logger } from '../config/logger';
import { passwordMatches } from '../services/passwordCheck';
import { isLockedOut, recordFailedAttempt } from '../services/loginLockout';
import { generateTotpSecret, otpauthUri, base32Encode, matchTotpStep, totpStep } from '../services/totp';
import { generateRecoveryCodes } from '../services/recoveryCodes';
import { terminateActiveSupportSessions } from '../services/supportSessions';
import { logPlatformAudit } from '../db/queries/platformAudit';
import {
  savePendingTotpSecret, readTotpSecret, readTotpState, isLocked, activateTotp, acceptTotpStep,
  recordTotpFailure, replaceRecoveryCodes, unusedRecoveryCodeCount, isTwoFactorRequired, TOTP_LOCK_MINUTES,
} from '../db/queries/twoFactorStore';

/**
 * Platform-admin two-factor, commit 2 of 4: enrolment (3 Oct 2026). Mounted at
 * /api/super-admin/two-factor, for platform admins only.
 *
 * Nothing here returns the secret or a recovery code except in the body of a POST response marked
 * not to be stored: never in a GET, never in a URL, where it would reach browser history and every
 * log on the way. Nothing here logs either, or puts either in an audit row.
 *
 * Decided, and not built: there is no way to switch two-factor off yourself. The way out of a lost
 * phone is recovery codes, then break-glass (docs/admin-two-factor-runbook.md). If it is ever built:
 * the password and a current code, audited. Moving to a new phone while the old one works is commit 5.
 */
const router = Router();
const guard = [verifyToken, requireRole('super_admin')];

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function refuse(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

const passwordSchema = z.object({ password: z.string().min(1, 'Enter your password') });
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') });

/**
 * A fresh token for the session that just enrolled: enrolment ended every session issued before it.
 * It records the second factor, because the admin has just typed a code from the authenticator, and
 * verifyToken refuses an enrolled admin's token without one (commit 4).
 */
function freshToken(req: Request): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  const claims: Record<string, unknown> = { ...(req.user as unknown as Record<string, unknown>), second_factor: 'totp' };
  delete claims.iat;
  delete claims.exp;
  return jwt.sign(claims, secret, { expiresIn: '1h' });
}

// ── GET /status ──────────────────────────────────────────────────────────────
router.get('/status', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await readTotpState(req.user!.user_id);
    return res.json({
      success: true,
      data: {
        // Whether this admin must switch it on before reaching anything else (migration 058).
        required: await isTwoFactorRequired(req.user!.user_id),
        enabled: !!state?.activatedAt,
        enabled_at: state?.activatedAt ?? null,
        locked_until: isLocked(state) ? state!.lockedUntil : null,
        unused_recovery_codes: state?.activatedAt ? await unusedRecoveryCodeCount(req.user!.user_id) : 0,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ── POST /enrolment ──────────────────────────────────────────────────────────
// Re-enter the password first, so a stolen session alone cannot enrol an attacker's phone and lock
// the real admin out. A wrong password counts against the sign-in lockout. That means someone with a
// stolen session can lock the admin out of sign-in by failing it: accepted (decided 3 Oct 2026), as a
// stolen platform-admin session is already the bad day, and break-glass is the way out.
router.post('/enrolment', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });

    const userId = req.user!.user_id;
    const email = req.user!.email ?? '';
    const ip = clientIp(req) ?? 'unknown';
    const state = await readTotpState(userId);
    if (state?.activatedAt) return refuse(res, 409, 'TWO_FACTOR_ALREADY_ON', 'Two-factor sign-in is already on for this account.');

    if (await isLockedOut(email, ip)) return refuse(res, 429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
    if (!(await passwordMatches(email, parsed.data.password))) {
      const { locked } = await recordFailedAttempt(email, ip);
      if (locked) return refuse(res, 429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
      return refuse(res, 401, 'INVALID_PASSWORD', 'That password is not right.');
    }

    const secret = generateTotpSecret();
    if (!(await savePendingTotpSecret(userId, secret))) {
      return refuse(res, 409, 'TWO_FACTOR_ALREADY_ON', 'Two-factor sign-in is already on for this account.');
    }
    await logPlatformAudit({ adminId: userId, actionType: 'TWO_FACTOR_ENROLMENT_STARTED', targetUserId: userId, ipAddress: clientIp(req) ?? null });

    return res.set(NO_STORE).json({
      success: true,
      data: { otpauth_uri: otpauthUri(secret, email), secret: base32Encode(secret) },
    });
  } catch (err) {
    return next(err);
  }
});

// ── POST /enrolment/confirm ──────────────────────────────────────────────────
// One code from the authenticator switches it on (decision b, Moses, 3 Oct 2026: no recovery code
// typed back). The same response carries the recovery codes, once, and a fresh token, because
// switching it on ends every session the admin had, this one included.
router.post('/enrolment/confirm', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });

    const userId = req.user!.user_id;
    const stored = await readTotpSecret(userId);
    if (!stored) return refuse(res, 409, 'NO_ENROLMENT_STARTED', 'Start setting up two-factor sign-in first.');
    if (stored.activatedAt) return refuse(res, 409, 'TWO_FACTOR_ALREADY_ON', 'Two-factor sign-in is already on for this account.');

    const now = Date.now() / 1000;
    const step = matchTotpStep(stored.secret, parsed.data.code, now);
    if (step === null) return refuse(res, 400, 'INVALID_CODE', 'That code is not right. Check the time on your phone, and use the newest code.');
    // -1, 0 or +1: drift in the server's clock shows here first (see routes/auth.ts, /login/verify).
    logger.info('totp_code_accepted', { user_id: userId, step_offset: step - totpStep(now), route: 'enrolment' });

    const codes = generateRecoveryCodes();
    const switchedOn = await activateTotp(userId, step, codes, {
      adminId: userId,
      actionType: 'TWO_FACTOR_ENABLED',
      targetUserId: userId,
      metadata: { recovery_codes_issued: codes.length },
      ipAddress: clientIp(req) ?? null,
    });
    if (!switchedOn) return refuse(res, 409, 'TWO_FACTOR_ALREADY_ON', 'Two-factor sign-in is already on for this account.');
    await terminateActiveSupportSessions(userId);

    return res.set(NO_STORE).json({ success: true, data: { recovery_codes: codes, access_token: freshToken(req) } });
  } catch (err) {
    return next(err);
  }
});

// ── POST /recovery-codes ─────────────────────────────────────────────────────
// A new set, replacing the old, for a current authenticator code. Without the code, a stolen session
// could mint codes and walk past the second factor, so a wrong code counts twice: against the
// database counter that locks the factor (Redis-independent, decision c) and the sign-in lockout.
router.post('/recovery-codes', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });

    const userId = req.user!.user_id;
    const email = req.user!.email ?? '';
    const ip = clientIp(req) ?? 'unknown';
    const state = await readTotpState(userId);
    if (!state?.activatedAt) return refuse(res, 409, 'TWO_FACTOR_NOT_ON', 'Two-factor sign-in is not on for this account.');
    if (isLocked(state)) return refuse(res, 423, 'TWO_FACTOR_LOCKED', `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.`);

    const stored = await readTotpSecret(userId);
    const now = Date.now() / 1000;
    const step = stored ? matchTotpStep(stored.secret, parsed.data.code, now) : null;
    const accepted = step !== null && await acceptTotpStep(userId, step);
    if (accepted) logger.info('totp_code_accepted', { user_id: userId, step_offset: step! - totpStep(now), route: 'recovery-codes' });
    if (!accepted) {
      const { failedAttempts, locked } = await recordTotpFailure(userId);
      await recordFailedAttempt(email, ip);
      if (locked) {
        logger.error('two_factor_locked', { user_id: userId, failed_attempts: failedAttempts, route: 'recovery-codes' });
        await logPlatformAudit({ adminId: userId, actionType: 'TWO_FACTOR_LOCKED', targetUserId: userId, metadata: { failed_attempts: failedAttempts, route: 'recovery-codes' }, ipAddress: clientIp(req) ?? null });
        return refuse(res, 423, 'TWO_FACTOR_LOCKED', `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.`);
      }
      return refuse(res, 400, 'INVALID_CODE', 'That code is not right, or it has already been used. Wait for the next one.');
    }

    const codes = generateRecoveryCodes();
    await replaceRecoveryCodes(userId, codes, {
      adminId: userId,
      actionType: 'RECOVERY_CODES_REGENERATED',
      targetUserId: userId,
      metadata: { recovery_codes_issued: codes.length },
      ipAddress: clientIp(req) ?? null,
    });
    return res.set(NO_STORE).json({ success: true, data: { recovery_codes: codes } });
  } catch (err) {
    return next(err);
  }
});

export default router;
