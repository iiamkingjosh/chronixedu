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
 */

export type ResetLanding =
  | { kind: 'token'; accessToken: string }
  | { kind: 'supabase_error'; errorCode: string | null; message: string }
  | { kind: 'unsupported_format'; message: string }
  | { kind: 'no_parameters'; message: string };

/** What the page reports to the API for a landing it cannot use (POST /api/auth/reset-landing). */
export type LandingOutcome = 'no_parameters' | 'supabase_error' | 'unsupported_format' | 'token_refused';

export const MESSAGES = {
  usedOrExpired:
    'This reset link has already been used or has expired. Each link works once, for a limited time. ' +
    'Some email services open links to check them, which can use a link up before you click it. Request a new link below.',
  unsupportedFormat:
    'This reset link arrived in a form this page cannot read. Your link is not at fault. ' +
    'Please contact your school administrator or Chronix support, and request a new link below in case it works.',
  noParameters:
    'This page needs the link from your password-reset email, and none came with it. ' +
    'If you did click the link in the email, it may have been changed on the way. Request a new link below.',
  sessionExpired:
    'This reset link has expired: it stays valid for a limited time after you open it. Request a new link below.',
  noAccount:
    'Your login was recognised, but no Chronix Edu account is attached to it. This is a problem on our side, not with your link. ' +
    'Please contact your school administrator.',
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
      if (errorCode === 'otp_expired') return { kind: 'supabase_error', errorCode, message: MESSAGES.usedOrExpired };
      const description = p.get('error_description') ?? p.get('error') ?? 'an unknown error';
      return {
        kind: 'supabase_error',
        errorCode,
        message: `The reset service did not accept this link: "${description}". Request a new link below.`,
      };
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
    return { message: `Your new password was not accepted${apiMessage ? `: ${apiMessage}` : '.'} Please choose another.`, report: false };
  }
  return { message: apiMessage ?? 'Could not reset your password. Please try again.', report: false };
}
