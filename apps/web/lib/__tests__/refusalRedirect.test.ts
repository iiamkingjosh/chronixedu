import { errorCode, loginReasonFor, loginNoticeFor, setupRedirectFor, TWO_FACTOR_SETUP_PAGE } from '../refusalRedirect';

/**
 * A 401 goes to /login before anyone reads its body, so the reason has to travel in the address and
 * be said by the page it lands on (reviewer, 4 Oct 2026). These pin both ends of that hand-over.
 */
describe('a refused request lands on a page that says why', () => {
  it('reads the API error code, and nothing from a body without one', () => {
    expect(errorCode({ success: false, error: { code: 'SECOND_FACTOR_REQUIRED', message: 'x' } })).toBe('SECOND_FACTOR_REQUIRED');
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode({ error: { code: 42 } })).toBeUndefined();
    expect(errorCode('<html>502</html>')).toBeUndefined();
  });

  it('a missing second factor reaches /login as its own reason, and the page says it', () => {
    expect(loginReasonFor('SECOND_FACTOR_REQUIRED')).toBe('second-factor');
    expect(loginNoticeFor(loginReasonFor('SECOND_FACTOR_REQUIRED'))).toMatch(/authenticator app/);
    // The control: any other 401 is still an expired session, as before.
    for (const code of ['UNAUTHORIZED', 'SESSION_ENDED', 'TOKEN_REVOKED', undefined]) {
      expect({ code, reason: loginReasonFor(code) }).toEqual({ code, reason: 'expired' });
    }
    expect(loginNoticeFor('expired')).toBe('Your session expired. Please sign in again.');
    expect(loginNoticeFor('idle')).toMatch(/inactivity/);
    expect(loginNoticeFor(null)).toBeNull();
    expect(loginNoticeFor('anything-else')).toBeNull();
  });

  it('an admin who must set up two-factor is sent to the setup page, which says why', () => {
    expect(setupRedirectFor(403, 'TWO_FACTOR_SETUP_REQUIRED', '/super-admin/dashboard')).toBe(TWO_FACTOR_SETUP_PAGE);
    expect(setupRedirectFor(403, 'TWO_FACTOR_SETUP_REQUIRED', '/dashboard')).toBe(TWO_FACTOR_SETUP_PAGE);
  });

  it('never from the setup page itself, which would loop, and never for any other refusal', () => {
    expect(setupRedirectFor(403, 'TWO_FACTOR_SETUP_REQUIRED', TWO_FACTOR_SETUP_PAGE)).toBeNull();
    expect(setupRedirectFor(403, 'FORBIDDEN', '/super-admin/dashboard')).toBeNull();
    expect(setupRedirectFor(403, undefined, '/super-admin/dashboard')).toBeNull();
    expect(setupRedirectFor(401, 'TWO_FACTOR_SETUP_REQUIRED', '/super-admin/dashboard')).toBeNull();
  });
});
