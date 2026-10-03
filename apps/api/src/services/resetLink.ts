/**
 * Which Supabase access tokens may set a new password at POST /api/auth/confirm-reset
 * (SECURITY.md Round 35, decided 3 Oct 2026).
 *
 * A reset sets the password without the current one: the person has lost it, and the emailed link is
 * the proof. That stays. Until this, any valid access token for the account would do, and a Supabase
 * session minted one whenever it liked. Every sign-in left such a session behind, never expiring,
 * so each was a standing password reset reached without signing in, and so without the second
 * factor. Now:
 *  - only a reset link's own session counts. Supabase records how a session was authenticated in the
 *    token's `amr` claim: a reset link's session says `otp` (measured in production, 3 Oct 2026),
 *    a sign-in says `password`;
 *  - only within RESET_LINK_MAX_AGE_SECONDS of the link being opened. The `amr` timestamp is when
 *    the session was authenticated and survives refreshes, so a reset session left open cannot be
 *    used later;
 *  - once: the route revokes every Supabase session of the account after a reset, the one used
 *    included.
 *
 * The token is decoded, not verified, here. supabaseAdmin.auth.getUser has already verified it with
 * Supabase before this runs.
 */

export const RESET_LINK_METHODS = ['otp', 'recovery'];
export const RESET_LINK_MAX_AGE_SECONDS = 60 * 60;

export type ResetTokenVerdict =
  | { ok: true }
  | { ok: false; reason: 'unreadable' | 'not_a_reset_link' | 'too_old' };

export function judgeResetToken(accessToken: string, nowSeconds: number = Date.now() / 1000): ResetTokenVerdict {
  const body = accessToken.split('.')[1];
  if (!body) return { ok: false, reason: 'unreadable' };
  let payload: { amr?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const amr = Array.isArray(payload.amr) ? payload.amr as Array<{ method?: unknown; timestamp?: unknown }> : [];
  const linkTimes = amr
    .filter((e) => typeof e?.method === 'string' && RESET_LINK_METHODS.includes(e.method) && typeof e.timestamp === 'number')
    .map((e) => e.timestamp as number);
  if (linkTimes.length === 0) return { ok: false, reason: 'not_a_reset_link' };
  if (nowSeconds - Math.max(...linkTimes) > RESET_LINK_MAX_AGE_SECONDS) return { ok: false, reason: 'too_old' };
  return { ok: true };
}
