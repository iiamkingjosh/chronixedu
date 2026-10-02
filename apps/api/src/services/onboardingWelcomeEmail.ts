/**
 * The welcome email a new school's principal receives when onboarding completes: the first thing a
 * school ever gets from Chronix. Plain text and HTML carry the same content.
 *
 * - The set-password link is the Supabase verify link exactly as generated. In the HTML it is the
 *   href of "Set your password"; the plain text shows the URL itself. Visible text never names a
 *   different address than the link goes to, which would read as phishing and score as spam.
 * - Every other link shows its own URL as its text, so destination and text always match.
 * - Names and addresses are HTML-escaped: a principal's name is typed by an operator.
 * - The page around it (light background, white card, banner and "Reach out to us") is the shared
 *   layout in emailLayout.ts.
 */
import { renderEmail, escapeHtml as esc, BRAND_NAVY, EMAIL_TEXT, SUPPORT_EMAIL as SUPPORT } from './emailLayout';

// Re-exported for the tests and callers that read the palette from here.
export { BRAND_NAVY, EMAIL_PAGE_BACKGROUND, EMAIL_CARD_BACKGROUND, EMAIL_TEXT } from './emailLayout';

export interface OnboardingWelcomeInput {
  firstName: string;
  principalEmail: string;
  setPasswordLink: string;
  /** appBaseUrl(): the web app's public address, no trailing slash. */
  appUrl: string;
}

export function onboardingWelcomeEmail({ firstName, principalEmail, setPasswordLink, appUrl }: OnboardingWelcomeInput): { text: string; html: string } {
  const loginUrl = `${appUrl}/login`;
  const legalUrl = `${appUrl}/legal`;

  const text =
    `Hi ${firstName},\n\n` +
    `Welcome to Chronix Edu! Your school's account has been successfully set up and is now live and ready to use.\n\n` +
    `Set your password using this link:\n\n` +
    `${setPasswordLink}\n\n` +
    `The link works once and expires. If it has expired, go to ${loginUrl}, choose "Forgot password" and enter ${principalEmail}; a new link will be sent to this address.\n\n` +
    `Your login email is ${principalEmail}. Nobody at Chronix knows or will ask for your password.\n\n` +
    `GETTING STARTED\n\n` +
    `Here is a quick path to get your school fully set up:\n\n` +
    `1. Set your password using the link above, then log in at ${loginUrl}\n` +
    `2. Add your school logo and branding under Settings → School Identity\n` +
    `3. Set up your classes and subjects under Settings → Roster\n` +
    `4. Add your teachers under Settings → Users\n` +
    `5. Register your students under Registrar → Students\n\n` +
    `If you have any questions getting started, simply reply to this email or reach us at ${SUPPORT} — we are happy to help.\n\n` +
    `You can review our Terms of Service, Privacy Policy, Data Processing Agreement, and Acceptable Use Policy at ${legalUrl} at any time.\n\n` +
    `Welcome aboard, and we look forward to supporting your school's journey.\n\n` +
    `Warm regards,\n` +
    `The Chronix Technology Team\n` +
    `${SUPPORT}`;

  // Every link states its colour: left to the client, it renders blue, and purple once visited (Zoho, 2 Oct 2026).
  const a = (href: string, label: string) => `<a href="${esc(href)}" style="color:${BRAND_NAVY}">${esc(label)}</a>`;
  const self = (url: string) => a(url, url);
  const content = [
    `<p>Hi ${esc(firstName)},</p>`,
    `<p>Welcome to Chronix Edu! Your school's account has been successfully set up and is now live and ready to use.</p>`,
    `<p style="margin:24px 0"><a href="${esc(setPasswordLink)}" style="background:${BRAND_NAVY};color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Set your password</a></p>`,
    `<p>The link works once and expires. If it has expired, go to ${self(loginUrl)}, choose "Forgot password" and enter ${esc(principalEmail)}; a new link will be sent to this address.</p>`,
    `<p>Your login email is ${esc(principalEmail)}. Nobody at Chronix knows or will ask for your password.</p>`,
    `<h3 style="color:${EMAIL_TEXT}">Getting started</h3>`,
    `<ol>`,
    `<li>Set your password using the button above, then log in at ${self(loginUrl)}</li>`,
    `<li>Add your school logo and branding under Settings → School Identity</li>`,
    `<li>Set up your classes and subjects under Settings → Roster</li>`,
    `<li>Add your teachers under Settings → Users</li>`,
    `<li>Register your students under Registrar → Students</li>`,
    `</ol>`,
    `<p>If you have any questions getting started, simply reply to this email or reach us at ${a(`mailto:${SUPPORT}`, SUPPORT)} — we are happy to help.</p>`,
    `<p>You can review our Terms of Service, Privacy Policy, Data Processing Agreement, and Acceptable Use Policy at ${self(legalUrl)} at any time.</p>`,
    `<p>Welcome aboard, and we look forward to supporting your school's journey.</p>`,
    `<p>Warm regards,<br>The Chronix Technology Team<br>${a(`mailto:${SUPPORT}`, SUPPORT)}</p>`,
  ].join('\n');

  const html = renderEmail({ title: 'Welcome to Chronix Edu', bodyHtml: content, appUrl });

  return { text, html };
}
