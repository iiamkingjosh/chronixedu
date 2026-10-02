/**
 * Every shape Supabase can send to /reset-password, each with the message that names its cause.
 * The page used to show one sentence ("invalid or has expired") for every failure. Each assertion
 * names the specific message, never merely "an error appeared", because a page that fails for the
 * wrong reason also shows an error (doctrine 16).
 *
 * The first two shapes are the ones observed on 2 Oct 2026 by following a real reset email from the
 * app's own flow, with the token values replaced.
 */
import { readResetLanding, confirmResetFailure, MESSAGES } from '../resetLanding';

const OLD_SENTENCE = 'This reset link is invalid or has expired. Please request a new password reset link.';

/** No message explains the mechanism, and none repeats what the "Request a new link" button says. */
function expectShortAndPlain(message: string) {
  expect(message).not.toMatch(/request a new link below|email services|token|on the way|not at fault/i);
  expect(message.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
}

describe('readResetLanding', () => {
  it('reads the token from the shape a working link lands with (fragment, implicit flow)', () => {
    const hash = '#access_token=tok123&expires_at=1&expires_in=3600&refresh_token=ref&sb=&token_type=bearer&type=recovery';
    expect(readResetLanding('', hash)).toEqual({ kind: 'token', accessToken: 'tok123' });
  });

  it('says a used or expired link was used or expired, from the shape Supabase sends for one', () => {
    const hash = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=';
    const landing = readResetLanding('', hash);
    expect(landing).toEqual({ kind: 'supabase_error', errorCode: 'otp_expired', message: 'This link has already been used, or it has expired.' });
    expect(landing.kind === 'supabase_error' && landing.message).toBe(MESSAGES.usedOrExpired);
  });

  it("any other Supabase error says the link could not be used, keeps its code for the report, and hides Supabase's wording", () => {
    const landing = readResetLanding('?error=server_error&error_code=unexpected_failure&error_description=Database+error+finding+user', '');
    expect(landing).toEqual({ kind: 'supabase_error', errorCode: 'unexpected_failure', message: 'This link could not be used.' });
  });

  it('recognises a PKCE ?code= link as a format the page cannot read, not as an expired link', () => {
    expect(readResetLanding('?code=abc-123', '')).toEqual({ kind: 'unsupported_format', message: 'This link could not be read. Please request a new one.' });
  });

  it('says the page was opened without a link when nothing came with it', () => {
    expect(readResetLanding('', '')).toEqual({ kind: 'no_parameters', message: 'This page needs the link from your password-reset email.' });
  });

  it('still reads the older query-string form of the token', () => {
    expect(readResetLanding('?access_token=tok456&type=recovery', '')).toEqual({ kind: 'token', accessToken: 'tok456' });
  });

  it('gives each failure its own short message, and none of them is the old catch-all sentence', () => {
    const messages = [
      readResetLanding('', '#error=access_denied&error_code=otp_expired'),
      readResetLanding('?error=server_error&error_code=unexpected_failure', ''),
      readResetLanding('?code=x', ''),
      readResetLanding('', ''),
    ].map(l => (l.kind === 'token' ? '' : l.message));
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) {
      expect(m).not.toBe(OLD_SENTENCE);
      expectShortAndPlain(m);
    }
    for (const m of Object.values(MESSAGES)) expectShortAndPlain(m);
  });
});

describe('confirmResetFailure', () => {
  it('a lapsed session is "expired", and is reported', () => {
    expect(confirmResetFailure('INVALID_TOKEN', 'This reset link is invalid or has expired.')).toEqual({ message: 'This link has expired.', report: true });
  });

  it('a login with no app account is sent to the school administrator (the API logs it itself)', () => {
    expect(confirmResetFailure('NO_APP_ACCOUNT', 'whatever')).toEqual({
      message: 'Your sign-in has no Chronix Edu account. Please contact your school administrator.', report: false });
  });

  it("a password Supabase refuses shows Supabase's reason, not an expired link", () => {
    expect(confirmResetFailure('PASSWORD_UPDATE_FAILED', 'New password should be different from the old password.').message)
      .toBe('Your new password was not accepted: New password should be different from the old password.');
  });
});
