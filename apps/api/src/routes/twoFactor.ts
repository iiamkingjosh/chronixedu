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
  savePendingDeviceMove, readPendingDeviceMove, completeDeviceMove, setTwoFactorRequired, DEVICE_MOVE_MINUTES,
  consumeRecoveryCode, disableTwoFactor,
} from '../db/queries/twoFactorStore';

/**
 * Platform-admin two-factor: enrolment (commit 2, 3 Oct 2026), moving to a new phone and the
 * requirement setting (commit 5, 4 Oct 2026), and turning it off (4 Oct 2026). Mounted at
 * /api/super-admin/two-factor, for platform admins only.
 *
 * Nothing here returns the secret or a recovery code except in the body of a POST response marked
 * not to be stored: never in a GET, never in a URL, where it would reach browser history and every
 * log on the way. Nothing here logs either, or puts either in an audit row.
 *
 * Turning it off was decided against on 3 Oct 2026 and reversed deliberately on 4 Oct at Moses's request,
 * on the conditions that decision set: the password and a current code (or a recovery code), audited.
 * It is refused while the account is marked required. A lost phone is still recovery codes, then
 * break-glass (docs/admin-two-factor-runbook.md).
 */
const router = Router();
const guard = [verifyToken, requireRole('super_admin')];

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function refuse(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message } });
}

const passwordSchema = z.object({ password: z.string().min(1, 'Enter your password') });
const sixDigits = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');
const codeSchema = z.object({ code: sixDigits });
const deviceMoveSchema = z.object({ password: z.string().min(1, 'Enter your password'), code: sixDigits });
const requirementSchema = z.object({ required: z.boolean({ message: 'Say whether two-factor sign-in is required' }) });
// Turning it off: the password, and exactly one of a current code or a recovery code.
const disableSchema = z
  .object({
    password: z.string().min(1, 'Enter your password'),
    code: sixDigits.optional(),
    recovery_code: z.string().trim().min(16).max(40).optional(),
  })
  .refine((d) => (d.code ? 1 : 0) + (d.recovery_code ? 1 : 0) === 1, {
    message: 'Enter a code from your authenticator app, or one recovery code',
    path: ['code'],
  });

/** The root platform admin (ROOT_ADMIN_EMAIL), the only one who may make two-factor optional again. */
function isRootAdmin(req: Request): boolean {
  const root = process.env.ROOT_ADMIN_EMAIL?.toLowerCase();
  return !!root && req.user?.email?.toLowerCase() === root;
}

/**
 * A wrong authenticator code from a signed-in admin counts twice: against the database counter that
 * locks the factor (Redis-independent, decision c) and against the sign-in lockout. The first lock
 * alerts and is audited. Shared by every route here that takes a code, so they count alike.
 */
async function refuseWrongCode(req: Request, res: Response, userId: string, email: string, ip: string, route: string) {
  const { failedAttempts, locked } = await recordTotpFailure(userId);
  await recordFailedAttempt(email, ip);
  if (locked) {
    logger.error('two_factor_locked', { user_id: userId, failed_attempts: failedAttempts, route });
    await logPlatformAudit({ adminId: userId, actionType: 'TWO_FACTOR_LOCKED', targetUserId: userId, metadata: { failed_attempts: failedAttempts, route }, ipAddress: clientIp(req) ?? null });
    return refuse(res, 423, 'TWO_FACTOR_LOCKED', `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.`);
  }
  return refuse(res, 400, 'INVALID_CODE', 'That code is not right, or it has already been used. Wait for the next one.');
}

/**
 * A fresh token for a session that just ended every other one (enrolment, a phone move, turning it
 * off). After enrolment or a move it records the second factor, because the admin has just typed a code
 * from the authenticator and verifyToken refuses an enrolled admin's token without one (commit 4).
 * After turning it off it records none, because there is no longer a second factor to record.
 */
function freshToken(req: Request, withSecondFactor = true): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  const claims: Record<string, unknown> = { ...(req.user as unknown as Record<string, unknown>) };
  delete claims.iat;
  delete claims.exp;
  delete claims.second_factor;
  if (withSecondFactor) claims.second_factor = 'totp';
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
        // Only the root admin may make it optional again (PUT /required), so the page offers that to them.
        may_make_optional: isRootAdmin(req),
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
    if (!accepted) return refuseWrongCode(req, res, userId, email, ip, 'recovery-codes');
    logger.info('totp_code_accepted', { user_id: userId, step_offset: step! - totpStep(now), route: 'recovery-codes' });

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

// ── POST /device-move ────────────────────────────────────────────────────────
// Moving to a new phone while the old one works (commit 5). The password and a current code from the
// OLD phone come first: a stolen session alone must not be able to move the factor to an attacker's
// phone, and the code proves the old phone is in hand. The new secret then waits beside the working one
// (migration 059) and is returned once, in this POST body, marked not to be stored. The old phone keeps
// working until /device-move/confirm; walking away changes nothing. A lost phone is not this path:
// that is a recovery code, then break-glass.
router.post('/device-move', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = deviceMoveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });

    const userId = req.user!.user_id;
    const email = req.user!.email ?? '';
    const ip = clientIp(req) ?? 'unknown';
    const state = await readTotpState(userId);
    if (!state?.activatedAt) return refuse(res, 409, 'TWO_FACTOR_NOT_ON', 'Two-factor sign-in is not on for this account.');
    if (isLocked(state)) return refuse(res, 423, 'TWO_FACTOR_LOCKED', `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.`);

    if (await isLockedOut(email, ip)) return refuse(res, 429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
    if (!(await passwordMatches(email, parsed.data.password))) {
      const { locked } = await recordFailedAttempt(email, ip);
      if (locked) return refuse(res, 429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
      return refuse(res, 401, 'INVALID_PASSWORD', 'That password is not right.');
    }

    const stored = await readTotpSecret(userId);
    const now = Date.now() / 1000;
    const step = stored ? matchTotpStep(stored.secret, parsed.data.code, now) : null;
    const accepted = step !== null && await acceptTotpStep(userId, step);
    if (!accepted) return refuseWrongCode(req, res, userId, email, ip, 'device-move');
    logger.info('totp_code_accepted', { user_id: userId, step_offset: step! - totpStep(now), route: 'device-move' });

    const secret = generateTotpSecret();
    if (!(await savePendingDeviceMove(userId, secret))) {
      return refuse(res, 409, 'TWO_FACTOR_NOT_ON', 'Two-factor sign-in is not on for this account.');
    }
    await logPlatformAudit({ adminId: userId, actionType: 'TWO_FACTOR_DEVICE_MOVE_STARTED', targetUserId: userId, ipAddress: clientIp(req) ?? null });

    return res.set(NO_STORE).json({
      success: true,
      data: { otpauth_uri: otpauthUri(secret, email), secret: base32Encode(secret), expires_in: DEVICE_MOVE_MINUTES * 60 },
    });
  } catch (err) {
    return next(err);
  }
});

// ── POST /device-move/confirm ────────────────────────────────────────────────
// A code from the NEW phone switches to it, in one transaction: the new secret becomes the active one,
// every other session ends (as at enrolment), and the move is audited. The recovery codes are kept
// (decided 4 Oct 2026). This session carries on with a fresh token. A wrong code counts like any other.
router.post('/device-move/confirm', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = codeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });

    const userId = req.user!.user_id;
    const email = req.user!.email ?? '';
    const ip = clientIp(req) ?? 'unknown';
    const state = await readTotpState(userId);
    if (!state?.activatedAt) return refuse(res, 409, 'TWO_FACTOR_NOT_ON', 'Two-factor sign-in is not on for this account.');
    if (isLocked(state)) return refuse(res, 423, 'TWO_FACTOR_LOCKED', `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.`);

    const notStarted = () => refuse(res, 409, 'DEVICE_MOVE_NOT_STARTED',
      `Nothing is waiting to be confirmed. Start the move again: it lasts ${DEVICE_MOVE_MINUTES} minutes.`);
    const pending = await readPendingDeviceMove(userId);
    if (!pending) return notStarted();

    const now = Date.now() / 1000;
    const step = matchTotpStep(pending.secret, parsed.data.code, now);
    if (step === null) return refuseWrongCode(req, res, userId, email, ip, 'device-move-confirm');
    logger.info('totp_code_accepted', { user_id: userId, step_offset: step - totpStep(now), route: 'device-move-confirm' });

    const moved = await completeDeviceMove(userId, pending.ciphertext, step, {
      adminId: userId,
      actionType: 'TWO_FACTOR_DEVICE_MOVED',
      targetUserId: userId,
      metadata: { recovery_codes_kept: true },
      ipAddress: clientIp(req) ?? null,
    });
    if (!moved) return notStarted();
    await terminateActiveSupportSessions(userId);

    return res.set(NO_STORE).json({ success: true, data: { access_token: freshToken(req) } });
  } catch (err) {
    return next(err);
  }
});

// ── PUT /required ────────────────────────────────────────────────────────────
// Whether this admin's own account must have two-factor (migration 058). Turning it on is open to any
// platform admin, for their own account only. Turning it off is the root admin's alone: every admin
// created since commit 4 is required, so that the choice is Moses's and not each added admin's.
// Either direction is audited with the previous value, read under the same lock as the write.
//
// Not a setup route: an admin confined to setup cannot reach it (TWO_FACTOR_SETUP_ROUTES), so a
// required admin cannot turn the requirement off before setting two-factor up. An admin without
// two-factor who turns it on is confined at once; the page says so before the click (decided 4 Oct 2026).
router.put('/required', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = requirementSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });

    if (!parsed.data.required && !isRootAdmin(req)) {
      return refuse(res, 403, 'ROOT_ADMIN_REQUIRED', 'Only the root platform admin can make two-factor sign-in optional.');
    }
    const result = await setTwoFactorRequired(req.user!.user_id, parsed.data.required, clientIp(req) ?? null);
    if (!result) return refuse(res, 404, 'NOT_FOUND', 'No platform admin account was found for this session.');

    return res.json({ success: true, data: { required: parsed.data.required, previous: result.previous, changed: result.changed } });
  } catch (err) {
    return next(err);
  }
});

// ── POST /disable ────────────────────────────────────────────────────────────
// Turning two-factor off (4 Oct 2026). Never a session alone: a stolen session must not be able to
// switch off the second factor it was meant to be stopped by. So the password and a current code (or,
// with the phone lost, one recovery code, which is spent). Refused while the account is marked
// required: otherwise "required" would mean nothing, and the root admin makes it optional first, as a
// separate recorded step. Not a setup route: an admin confined to setup cannot reach it.
router.post('/disable', ...guard, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = disableSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.flatten() } });

    const userId = req.user!.user_id;
    const email = req.user!.email ?? '';
    const ip = clientIp(req) ?? 'unknown';
    const required = () => refuse(res, 409, 'TWO_FACTOR_REQUIRED_FOR_ACCOUNT',
      'Two-factor sign-in is required for this account, so it cannot be turned off. The root admin must make it optional first.');
    const state = await readTotpState(userId);
    if (!state?.activatedAt) return refuse(res, 409, 'TWO_FACTOR_NOT_ON', 'Two-factor sign-in is not on for this account.');
    if (await isTwoFactorRequired(userId)) return required();
    if (isLocked(state)) return refuse(res, 423, 'TWO_FACTOR_LOCKED', `Too many wrong codes. Try again in ${TOTP_LOCK_MINUTES} minutes.`);

    if (await isLockedOut(email, ip)) return refuse(res, 429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
    if (!(await passwordMatches(email, parsed.data.password))) {
      const { locked } = await recordFailedAttempt(email, ip);
      if (locked) return refuse(res, 429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
      return refuse(res, 401, 'INVALID_PASSWORD', 'That password is not right.');
    }

    // The proof is checked, and a recovery code spent, before the transaction below. In the rare race
    // where the account is marked required in between, the transaction refuses and the spent recovery
    // code stays spent: one code lost, and nothing turned off.
    const method: 'totp' | 'recovery_code' = parsed.data.code ? 'totp' : 'recovery_code';
    if (parsed.data.code) {
      const stored = await readTotpSecret(userId);
      const now = Date.now() / 1000;
      const step = stored ? matchTotpStep(stored.secret, parsed.data.code, now) : null;
      const accepted = step !== null && await acceptTotpStep(userId, step);
      if (!accepted) return refuseWrongCode(req, res, userId, email, ip, 'disable');
      logger.info('totp_code_accepted', { user_id: userId, step_offset: step! - totpStep(now), route: 'disable' });
    } else if (!(await consumeRecoveryCode(userId, parsed.data.recovery_code!))) {
      return refuseWrongCode(req, res, userId, email, ip, 'disable');
    }

    const outcome = await disableTwoFactor(userId, method, clientIp(req) ?? null);
    if (outcome === 'required') return required();
    if (outcome === 'not_on') return refuse(res, 409, 'TWO_FACTOR_NOT_ON', 'Two-factor sign-in is not on for this account.');
    await terminateActiveSupportSessions(userId);

    return res.set(NO_STORE).json({ success: true, data: { access_token: freshToken(req, false) } });
  } catch (err) {
    return next(err);
  }
});

export default router;
