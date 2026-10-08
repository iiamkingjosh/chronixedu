import { formatCountdown, secondsUntil, retryAfterFrom } from '../countdown';

describe('the sign-in lockout countdown', () => {
  it('shows minutes and seconds, at each edge', () => {
    expect(formatCountdown(754)).toBe('12:34');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(59)).toBe('0:59');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('counts whole seconds left, rounded up, and stops at zero', () => {
    const now = 1_000_000;
    expect(secondsUntil(now + 540_000, now)).toBe(540);
    expect(secondsUntil(now + 1, now)).toBe(1); // a fraction of a second still waits
    expect(secondsUntil(now, now)).toBe(0);
    expect(secondsUntil(now - 5_000, now)).toBe(0);
  });

  it('reads the wait from a refusal, and nothing from one that names none', () => {
    expect(retryAfterFrom({ error: { code: 'ACCOUNT_LOCKED', message: 'x', retry_after_seconds: 541 } })).toBe(541);
    expect(retryAfterFrom({ error: { code: 'ACCOUNT_LOCKED', message: 'x', retry_after_seconds: null } })).toBeNull();
    expect(retryAfterFrom({ error: { code: 'INVALID_CREDENTIALS', message: 'x' } })).toBeNull();
    expect(retryAfterFrom({ error: { retry_after_seconds: 'soon' } })).toBeNull();
    expect(retryAfterFrom({ error: { retry_after_seconds: 0 } })).toBeNull();
    expect(retryAfterFrom(null)).toBeNull();
  });
});
