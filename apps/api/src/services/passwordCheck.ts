import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabaseClient';
import { logger } from '../config/logger';

/**
 * Checks a signed-in person's password again, before a sensitive act (2FA enrolment), the same way
 * sign-in checks it: through Supabase Auth, not the local users.password_hash, which can be stale.
 *
 * signInWithPassword creates a Supabase session as a side effect, with a refresh token that never
 * expires. Production held 56 such sessions for 7 accounts on 3 Oct 2026, the oldest from 19 Aug,
 * one left behind by every sign-in (docs/AUDIT-2026-09.md). This check leaves none:
 *  - its own client, which keeps no session in memory and refreshes nothing, so the shared client
 *    in supabaseClient.ts is never handed this person's session;
 *  - the session it creates is revoked at once (admin signOut, this session only).
 * A failed revocation does not fail the check; it is logged and alerted, never swallowed.
 */
function checkingClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function passwordMatches(email: string, password: string): Promise<boolean> {
  const { data, error } = await checkingClient().auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  try {
    const { error: revokeError } = await supabaseAdmin.auth.admin.signOut(data.session.access_token, 'local');
    if (revokeError) throw revokeError;
  } catch (err) {
    logger.error('password_check_session_not_revoked', {
      user_id: data.user?.id ?? null,
      // Supabase's AuthError is an Error, but a plain { message } must not log as "[object Object]".
      error: err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err),
    });
  }
  return true;
}
