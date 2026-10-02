/**
 * The welcome email a new school's principal receives when onboarding completes: the first thing a
 * school ever gets from Chronix. Plain text and HTML carry the same content.
 *
 * - The set-password link is the Supabase verify link exactly as generated. In the HTML it is the
 *   href of "Set your password"; the plain text shows the URL itself. Visible text never names a
 *   different address than the link goes to, which would read as phishing and score as spam.
 * - Every other link shows its own URL as its text, so destination and text always match.
 * - Names and addresses are HTML-escaped: a principal's name is typed by an operator.
 */
export interface OnboardingWelcomeInput {
  firstName: string;
  principalEmail: string;
  setPasswordLink: string;
  /** appBaseUrl(): the web app's public address, no trailing slash. */
  appUrl: string;
}

const SUPPORT = 'support@chronixtechnology.com';

/**
 * Chronix navy, copied from apps/web/tailwind.config.ts (navy.DEFAULT; the API cannot import the web
 * config). Change it there and here together, and invent no shade. One flat colour per element:
 * email clients ignore :hover.
 */
export const BRAND_NAVY = '#003366';

/**
 * The email brings its own light page, so its colours do not depend on the reader's client. The first
 * version had no background of its own. On a dark-themed client (Zoho, 2 Oct 2026) navy text would
 * have sat at about 1.3:1 against the dark background, so the button and every link would vanish.
 * On this white card, navy and white-on-navy are both 12.6:1. The color-scheme metas ask Apple Mail
 * and Outlook not to invert it.
 */
export const EMAIL_PAGE_BACKGROUND = '#f4f5f7';
export const EMAIL_CARD_BACKGROUND = '#ffffff';
export const EMAIL_TEXT = '#111827';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  // Tables, not divs: Outlook ignores max-width on a div.
  const html = [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light">`,
    `<meta name="supported-color-schemes" content="light">`,
    `<title>Welcome to Chronix Edu</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background-color:${EMAIL_PAGE_BACKGROUND}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_PAGE_BACKGROUND}">`,
    `<tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${EMAIL_CARD_BACKGROUND};color:${EMAIL_TEXT};border-radius:8px">`,
    `<tr><td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${EMAIL_TEXT}">`,
    content,
    `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</body>`,
    `</html>`,
  ].join('\n');

  return { text, html };
}
