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

/** True when the email or the address has reached its limit. False when Redis is absent or failing. */
export async function isLockedOut(email: string, ip: string): Promise<boolean> {
  if (!redis) return false;
  const r = redis;
  const { emailKey, ipKey } = keys(email, ip);
  const counts = await bestEffort('login_lockout_unavailable', () => Promise.all([r.get(emailKey), r.get(ipKey)]));
  if (!counts) return false;
  const [emailCount, ipCount] = counts;
  return (emailCount !== null && parseInt(emailCount, 10) >= MAX_ATTEMPTS)
    || (ipCount !== null && parseInt(ipCount, 10) >= MAX_IP_ATTEMPTS);
}

/**
 * Counts one failure against both keys. `counted` is false only when there is no Redis client at
 * all; `locked` is true when this failure reached a limit.
 */
export async function recordFailedAttempt(email: string, ip: string): Promise<{ counted: boolean; locked: boolean }> {
  if (!redis) return { counted: false, locked: false };
  const r = redis;
  const { emailKey, ipKey } = keys(email, ip);
  const attempts = await bestEffort('login_lockout_unavailable', async () => {
    const [emailAttempts, ipAttempts] = await Promise.all([r.incr(emailKey), r.incr(ipKey)]);
    if (emailAttempts === 1) await r.expire(emailKey, LOCK_WINDOW_SECONDS);
    if (ipAttempts === 1) await r.expire(ipKey, LOCK_WINDOW_SECONDS);
    return [emailAttempts, ipAttempts] as const;
  });
  return { counted: true, locked: !!attempts && (attempts[0] >= MAX_ATTEMPTS || attempts[1] >= MAX_IP_ATTEMPTS) };
}

/** Clears both counters after a person has fully proved who they are. Best-effort. */
export async function clearFailedAttempts(email: string, ip: string): Promise<void> {
  if (!redis) return;
  const r = redis;
  const { emailKey, ipKey } = keys(email, ip);
  await bestEffort('login_lockout_unavailable', () => Promise.all([r.del(emailKey), r.del(ipKey)]));
}
