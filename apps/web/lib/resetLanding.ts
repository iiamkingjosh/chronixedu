/**
 * What arrived at /reset-password, and what to tell the person.
 *
 * Since H2 (1 Oct 2026) "Forgot password" is how every staff member and parent sets a password, so
 * this page is the only way in. It used to read one shape (`access_token` with `type=recovery`) and
 * show one sentence ("invalid or has expired") for everything else, logging nothing anywhere. A
 * person who could not get in left no trace, and was told to retry something that might never have
 * been the problem.
 *
 * Shapes, observed on 2 Oct 2026 by following a real reset email from the app's own flow
 * (supabase-js defaults to the implicit flow):
 *   - success: `#access_token=…&expires_at=…&expires_in=…&refresh_token=…&sb&token_type=bearer&type=recovery`
 *   - a used or expired link: `#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb`
 * Recognised but not usable here: PKCE's `?code=…`. It needs a code verifier this page never holds.
 * If Supabase ever sends it, nobody can reset a password until this page is taught it, and the page
 * reports that.
 *
 * The messages say what happened and nothing about why: the person needs only that, and the
 * "Request a new link" button beside each one. The cause stays distinct where it is useful, in what
 * the page reports to the server (2 Oct 2026, after the first version explained token mechanics on
 * screen).
 */

export type ResetLanding =
  | { kind: 'token'; accessToken: string }
  | { kind: 'supabase_error'; errorCode: string | null; message: string }
  | { kind: 'unsupported_format'; message: string }
  | { kind: 'no_parameters'; message: string };

/** What the page reports to the API for a landing it cannot use (POST /api/auth/reset-landing). */
export type LandingOutcome = 'no_parameters' | 'supabase_error' | 'unsupported_format' | 'token_refused';

export const MESSAGES = {
  usedOrExpired: 'This link has already been used, or it has expired.',
  otherSupabaseError: 'This link could not be used.',
  unsupportedFormat: 'This link could not be read. Please request a new one.',
  noParameters: 'This page needs the link from your password-reset email.',
  sessionExpired: 'This link has expired.',
  noAccount: 'Your sign-in has no Chronix Edu account. Please contact your school administrator.',
} as const;

const params = (s: string) => new URLSearchParams(s.replace(/^[#?]/, ''));

/** Reads the landing from `location.search` and `location.hash`. Pure, so every shape is testable. */
export function readResetLanding(search: string, hash: string): ResetLanding {
  const fragment = params(hash);
  const query = params(search);

  for (const p of [fragment, query]) {
    const token = p.get('access_token');
    if (token && p.get('type') === 'recovery') return { kind: 'token', accessToken: token };
  }

  for (const p of [fragment, query]) {
    if (p.get('error') || p.get('error_code')) {
      const errorCode = p.get('error_code');
      // Supabase's code goes to the server with the report; its description is not for the person.
      return { kind: 'supabase_error', errorCode, message: errorCode === 'otp_expired' ? MESSAGES.usedOrExpired : MESSAGES.otherSupabaseError };
    }
  }

  if (query.get('code') || fragment.get('code')) return { kind: 'unsupported_format', message: MESSAGES.unsupportedFormat };
  return { kind: 'no_parameters', message: MESSAGES.noParameters };
}

/**
 * The message for a refusal from POST /api/auth/confirm-reset, and whether the page should report it
 * (the API logs the no-account case itself).
 */
export function confirmResetFailure(code: string | undefined, apiMessage: string | undefined): { message: string; report: boolean } {
  if (code === 'INVALID_TOKEN') return { message: MESSAGES.sessionExpired, report: true };
  if (code === 'NO_APP_ACCOUNT') return { message: MESSAGES.noAccount, report: false };
  if (code === 'PASSWORD_UPDATE_FAILED') {
    return { message: `Your new password was not accepted${apiMessage ? `: ${apiMessage}` : '.'}`, report: false };
  }
  return { message: apiMessage ?? 'Could not reset your password. Please try again.', report: false };
}
