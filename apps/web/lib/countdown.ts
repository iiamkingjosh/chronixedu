/**
 * The sign-in lockout's countdown (8 Oct 2026). The API says how many seconds are left on a lock
 * (`retry_after_seconds`); the page turns that into a moment and counts down to it, so a refresh of the
 * clock, not of the request, moves the number.
 */

/** Seconds from `now` until `until`, both in milliseconds, rounded up and never below zero. */
export function secondsUntil(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** 754 → "12:34", 59 → "0:59", 0 → "0:00". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The seconds a refusal says to wait, if it said: a whole, positive number, or null. */
export function retryAfterFrom(json: unknown): number | null {
  const v = (json as { error?: { retry_after_seconds?: unknown } } | null)?.error?.retry_after_seconds;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : null;
}
