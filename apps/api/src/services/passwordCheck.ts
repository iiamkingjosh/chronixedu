import { supabase, supabaseAdmin } from '../supabaseClient';
import { logger } from '../config/logger';

/**
 * The one way the API checks a password (SECURITY.md Round 35): POST /login, the 2FA enrolment
 * re-check, and the payout step-up in routes/schools.ts. Through Supabase Auth, not the local
 * users.password_hash, which can be stale.
 *
 * signInWithPassword creates a Supabase session as a side effect, with a refresh token that never
 * expires. Every sign-in since 19 Aug 2026 left one: production held 56 for its 7 accounts on 3 Oct.
 * A live session can mint an access token whenever it likes, and confirm-reset set a new password for
 * any access token, with no current password, so each was a standing password reset reached without
 * signing in. So the session is revoked at once (admin signOut, this session only), and the client
 * that made it keeps no session in memory (supabaseClient.ts).
 *
 * A failed revocation does not fail the check: the password was right. It is logged and alerted
 * (supabase_session_not_revoked), never swallowed. The token itself is never logged.
 */
export async function signInAndRevoke(email: string, password: string): Promise<string | null> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data?.user) return null;
  if (data.session) {
    try {
      const { error: revokeError } = await supabaseAdmin.auth.admin.signOut(data.session.access_token, 'local');
      if (revokeError) throw revokeError;
    } catch (err) {
      logger.error('password_check_session_not_revoked', {
        user_id: data.user.id,
        // Supabase's AuthError is an Error, but a plain { message } must not log as "[object Object]".
        error: err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err),
      });
    }
  }
  return data.user.id;
}

export async function passwordMatches(email: string, password: string): Promise<boolean> {
  return (await signInAndRevoke(email, password)) !== null;
}
