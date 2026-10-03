import { judgeResetToken, RESET_LINK_MAX_AGE_SECONDS } from '../services/resetLink';

/** A token shaped like Supabase's (header.payload.signature); only the payload is read. */
function supabaseToken(amr: Array<{ method: string; timestamp: number }>): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'auth-1', amr, session_id: 's1' })}.signature`;
}

const NOW = 1_759_500_000;

describe('which Supabase tokens may set a new password (Round 35)', () => {
  it('a reset link\'s session, opened within the hour, may', () => {
    expect(judgeResetToken(supabaseToken([{ method: 'otp', timestamp: NOW - 60 }]), NOW)).toEqual({ ok: true });
    expect(judgeResetToken(supabaseToken([{ method: 'recovery', timestamp: NOW - 60 }]), NOW)).toEqual({ ok: true });
    expect(judgeResetToken(supabaseToken([{ method: 'otp', timestamp: NOW - RESET_LINK_MAX_AGE_SECONDS }]), NOW)).toEqual({ ok: true });
  });

  it('a sign-in session may not, however fresh: that was the standing reset', () => {
    expect(judgeResetToken(supabaseToken([{ method: 'password', timestamp: NOW - 5 }]), NOW))
      .toEqual({ ok: false, reason: 'not_a_reset_link' });
  });

  it('a reset session opened more than an hour ago may not, even though its token is new', () => {
    expect(judgeResetToken(supabaseToken([{ method: 'otp', timestamp: NOW - RESET_LINK_MAX_AGE_SECONDS - 1 }]), NOW))
      .toEqual({ ok: false, reason: 'too_old' });
  });

  it('a token that cannot be read, or carries no amr, may not', () => {
    for (const bad of ['', 'not-a-token', 'a.%%%.c', 'a.' + Buffer.from('not json').toString('base64url') + '.c']) {
      expect({ bad, verdict: judgeResetToken(bad, NOW) }).toEqual({ bad, verdict: { ok: false, reason: 'unreadable' } });
    }
    expect(judgeResetToken(supabaseToken([]), NOW)).toEqual({ ok: false, reason: 'not_a_reset_link' });
  });
});
