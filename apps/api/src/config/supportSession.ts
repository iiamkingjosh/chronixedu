/**
 * How long a support (impersonation) session's token lives, read once, in seconds (4 Oct 2026,
 * docs/AUDIT-2026-09.md). SUPPORT_SESSION_MAX_DURATION_HOURS used to be read three ways in three
 * places: as text for the token ("1.5h"), with parseInt for the token store (1.5 became 1, 0.5 became
 * 0), and not at all for the revocation list (a typed-in 30 minutes). At 0.5 hours, ending a session
 * revoked nothing. Now one number drives all three, and a value that cannot be honoured stops the API
 * at boot (config/env.ts) instead of turning into something nobody configured.
 */

/** Unset: nothing was configured, so the default. A different fact from an invalid value. */
export const DEFAULT_SUPPORT_SESSION_SECONDS = 30 * 60;

/**
 * The setting in seconds; the default when unset or blank; null when it cannot be honoured
 * (not a plain positive number of hours: "2h", "abc", "0", "-1"). "0.5" is 1,800 seconds.
 */
export function parseSupportSessionHours(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return DEFAULT_SUPPORT_SESSION_SECONDS;
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const seconds = Math.round(Number(value.trim()) * 3600);
  return seconds > 0 ? seconds : null;
}

function readOnce(): number {
  const seconds = parseSupportSessionHours(process.env.SUPPORT_SESSION_MAX_DURATION_HOURS);
  if (seconds === null) {
    throw new Error(
      `SUPPORT_SESSION_MAX_DURATION_HOURS must be a positive number of hours, such as 0.5 or 2; ` +
      `got "${process.env.SUPPORT_SESSION_MAX_DURATION_HOURS}". Refusing to start rather than guess.`);
  }
  return seconds;
}

/** The support token's life. */
export const SUPPORT_SESSION_SECONDS: number = readOnce();

/**
 * The token store (read when a session ends, to find the token) and the revocation list both outlive
 * the token by a minute, so neither can forget it while it still works.
 */
export const SUPPORT_TOKEN_STORE_SECONDS: number = SUPPORT_SESSION_SECONDS + 60;
export const SUPPORT_TOKEN_REVOKED_SECONDS: number = SUPPORT_SESSION_SECONDS + 60;
