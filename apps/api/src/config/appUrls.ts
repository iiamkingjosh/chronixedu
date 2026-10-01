/**
 * Where a Supabase recovery link sends someone to set a password. One function for both callers,
 * forgot-password and onboarding's set-password link, because Supabase only honours a redirect on
 * its allow-list and this is the URL already on it.
 */
export function resetPasswordRedirect(): string {
  const base = process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/reset-password`;
}
