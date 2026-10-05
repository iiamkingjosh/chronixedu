import bcrypt from 'bcryptjs';

/**
 * A password cannot be reused within PASSWORD_REUSE_DAYS (Moses, 5 Oct 2026: "two months", confirmed
 * as 60 days, counted from when the old password stopped being used). It covers the account's current
 * password and every one it replaced in the window (password_history, migration 060).
 *
 * Enforced where a person sets their own password: POST /api/auth/confirm-reset (Forgot password)
 * and POST /api/auth/change-password, both through changeOwnPassword. It cannot see a password set in
 * the Supabase dashboard, nor one set by calling Supabase directly with a person's own reset session.
 */
export const PASSWORD_REUSE_DAYS = 60;

export const PASSWORD_RECENTLY_USED = {
  code: 'PASSWORD_RECENTLY_USED',
  message: 'You used this password in the last 2 months. Choose a different one.',
} as const;

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$/;

/** True when `candidate` matches any of `hashes`. Anything that is not a bcrypt hash ('') matches nothing. */
export async function matchesAnyPassword(candidate: string, hashes: string[]): Promise<boolean> {
  for (const hash of hashes) {
    if (BCRYPT_HASH.test(hash) && await bcrypt.compare(candidate, hash)) return true;
  }
  return false;
}
