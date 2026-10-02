/**
 * The web app's public base URL, from APP_URL and nothing else.
 *
 * There used to be eight separate expressions for it, with three different fallbacks:
 * `APP_URL ?? localhost`, `APP_URL ?? NEXTAUTH_URL ?? localhost`, `APP_URL ?? the production
 * address`, and one that read NEXTAUTH_URL alone. On production NEXTAUTH_URL was a leftover
 * `http://localhost:3000`, so the onboarding welcome email, the first thing a school receives, sent
 * the principal to their own machine for login, the legal pages and every getting-started step (2 Oct
 * 2026). Nothing here is NextAuth, and nothing reads NEXTAUTH_URL any more.
 *
 * No default. An unset APP_URL cannot be told apart from someone choosing localhost (doctrine 8), so
 * the API refuses to start without it (config/env.ts), and this throws if reached without it. Tests
 * state their value in their setup files.
 */
export function appBaseUrl(): string {
  const raw = process.env.APP_URL;
  if (!raw) {
    throw new Error('APP_URL is not set. It is the web app\'s public address (for example https://edu.chronixtechnology.com), used in every link the API sends.');
  }
  return raw.replace(/\/$/, '');
}

/**
 * Where a Supabase recovery link sends someone to set a password. One function for both callers,
 * forgot-password and onboarding's set-password link, because Supabase only honours a redirect on
 * its allow-list and this is the URL already on it.
 */
export function resetPasswordRedirect(): string {
  return `${appBaseUrl()}/reset-password`;
}
