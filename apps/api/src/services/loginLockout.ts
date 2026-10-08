import type { Response } from 'express';
import { redis, bestEffort } from '../middleware/rateLimit';

/**
 * The per-email and per-address sign-in lockout, shared since 3 Oct 2026 by POST /login and by
 * every other place a person proves who they are: the password re-check before 2FA enrolment, and
 * (from 2FA commit 3) a wrong second-factor code. One counter, so guesses on any of those paths add
 * up against the same limit.
 *
 * Redis-backed and best-effort (SECURITY.md Round 19, decided: fail open): with Redis down there is
 * no lockout at all, which is why the second factor carries its own counter in the database
 * (migration 056). Moved here from routes/auth.ts unchanged; authLockout.test.ts covers login.
 */

export const MAX_ATTEMPTS = 5;
export const MAX_IP_ATTEMPTS = 20; // higher threshold to avoid blocking shared NAT addresses
export const LOCK_WINDOW_SECONDS = 15 * 60;

function keys(email: string, ip: string) {
  return { emailKey: `login_attempts:${email.toLowerCase()}`, ipKey: `login_attempts_ip:${ip}` };
}

export interface LockState {
  locked: boolean;
  /**
   * How long until the lock lifts, read from the counters' own expiry: the longest of the counters that
   * are at their limit, since each must lapse. null when it could not be read. The window runs from the
   * FIRST failure, so this is usually less than the full 15 minutes the message used to promise.
   */
  retryAfterSeconds: number | null;
}

/**
 * Reads a set of counters with their limits: locked when any is at its limit, and for how long. The
 * lock is decided by the counts alone; the expiries are read separately, so failing to read them leaves
 * the lock in force and only the time unknown. Shared with the payout password check, which keeps its
 * own counters (routes/schools.ts).
 */
export async function readLock(counters: Array<{ key: string; max: number }>, event: string): Promise<LockState> {
  if (!redis) return { locked: false, retryAfterSeconds: null };
  const r = redis;
  const counts = await bestEffort(event, () => Promise.all(counters.map(c => r.get(c.key))));
  if (!counts) return { locked: false, retryAfterSeconds: null };
  const atLimit = counters.filter((c, i) => counts[i] !== null && parseInt(counts[i] as string, 10) >= c.max);
  if (atLimit.length === 0) return { locked: false, retryAfterSeconds: null };
  const ttls = await bestEffort(event, () => Promise.all(atLimit.map(c => r.ttl(c.key))));
  // A missing key (-2) or one with no expiry (-1) says nothing about when the lock lifts.
  const known = (ttls ?? []).filter((t): t is number => typeof t === 'number' && t > 0);
  return { locked: true, retryAfterSeconds: known.length > 0 ? Math.max(...known) : null };
}

/** Whether the email or the address has reached its limit, and for how long. Never locked when Redis is absent or failing. */
export async function lockoutState(email: string, ip: string): Promise<LockState> {
  const { emailKey, ipKey } = keys(email, ip);
  return readLock([{ key: emailKey, max: MAX_ATTEMPTS }, { key: ipKey, max: MAX_IP_ATTEMPTS }], 'login_lockout_unavailable');
}

/** True when the email or the address has reached its limit. False when Redis is absent or failing. */
export async function isLockedOut(email: string, ip: string): Promise<boolean> {
  return (await lockoutState(email, ip)).locked;
}

/** The refusal every lockout sends: the time left in the message, in `retry_after_seconds`, and in `Retry-After`. */
export function lockedOutError(retryAfterSeconds: number | null): { code: 'ACCOUNT_LOCKED'; message: string; retry_after_seconds: number | null } {
  if (retryAfterSeconds === null) {
    return { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts. Try again within 15 minutes.', retry_after_seconds: null };
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return {
    code: 'ACCOUNT_LOCKED',
    message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    retry_after_seconds: retryAfterSeconds,
  };
}

export function sendLockedOut(res: Response, retryAfterSeconds: number | null): Response {
  if (retryAfterSeconds !== null) res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ success: false, error: lockedOutError(retryAfterSeconds) });
}

/**
 * Counts one failure against both keys. `counted` is false only when there is no Redis client at
 * all; `locked` is true when this failure reached a limit, and `retryAfterSeconds` then says for how long.
 */
export async function recordFailedAttempt(
  email: string, ip: string
): Promise<{ counted: boolean; locked: boolean; retryAfterSeconds: number | null }> {
  if (!redis) return { counted: false, locked: false, retryAfterSeconds: null };
  const r = redis;
  const { emailKey, ipKey } = keys(email, ip);
  const attempts = await bestEffort('login_lockout_unavailable', async () => {
    const [emailAttempts, ipAttempts] = await Promise.all([r.incr(emailKey), r.incr(ipKey)]);
    if (emailAttempts === 1) await r.expire(emailKey, LOCK_WINDOW_SECONDS);
    if (ipAttempts === 1) await r.expire(ipKey, LOCK_WINDOW_SECONDS);
    return [emailAttempts, ipAttempts] as const;
  });
  const locked = !!attempts && (attempts[0] >= MAX_ATTEMPTS || attempts[1] >= MAX_IP_ATTEMPTS);
  if (!locked) return { counted: true, locked: false, retryAfterSeconds: null };
  return { counted: true, locked: true, retryAfterSeconds: (await lockoutState(email, ip)).retryAfterSeconds };
}

/** Clears both counters after a person has fully proved who they are. Best-effort. */
export async function clearFailedAttempts(email: string, ip: string): Promise<void> {
  if (!redis) return;
  const r = redis;
  const { emailKey, ipKey } = keys(email, ip);
  await bestEffort('login_lockout_unavailable', () => Promise.all([r.del(emailKey), r.del(ipKey)]));
}
