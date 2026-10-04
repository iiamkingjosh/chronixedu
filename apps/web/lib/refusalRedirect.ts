/**
 * Where a refused request sends the person, and what the page they land on says (2FA commit 4).
 *
 * The API's message never reaches a person on these paths: a 401 clears the session and goes to
 * /login before anything reads the body. So the reason travels in the address, and the page that
 * lands says it. Pure, so it is tested (lib/__tests__/refusalRedirect.test.ts).
 */

export const TWO_FACTOR_SETUP_PAGE = '/super-admin/security';

/** The API's error code, from a parsed JSON body, if there is one. */
export function errorCode(json: unknown): string | undefined {
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The ?reason= a 401 carries to /login. */
export function loginReasonFor(code: string | undefined): 'second-factor' | 'expired' {
  return code === 'SECOND_FACTOR_REQUIRED' ? 'second-factor' : 'expired';
}

/** What /login says for a ?reason=, or null for none it knows. */
export function loginNoticeFor(reason: string | null): string | null {
  switch (reason) {
    case 'idle':
      return 'You were logged out after 10 minutes of inactivity. Please sign in again.';
    case 'expired':
      return 'Your session expired. Please sign in again.';
    case 'second-factor':
      return 'Two-factor sign-in is on for your account. Sign in again, and enter the code from your authenticator app.';
    default:
      return null;
  }
}

/**
 * Where a 403 sends the person, or null to leave it to the page. Only a platform admin who must set
 * up two-factor is sent anywhere, and never from the setup page itself, which would loop.
 */
export function setupRedirectFor(status: number, code: string | undefined, pathname: string): string | null {
  if (status !== 403 || code !== 'TWO_FACTOR_SETUP_REQUIRED') return null;
  if (pathname === TWO_FACTOR_SETUP_PAGE || pathname.startsWith(TWO_FACTOR_SETUP_PAGE + '/')) return null;
  return TWO_FACTOR_SETUP_PAGE;
}
