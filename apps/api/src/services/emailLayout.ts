/**
 * The page every email in Chronix's own voice is built on (2 Oct 2026). Moved here from
 * onboardingWelcomeEmail.ts, which had it first, so each such email shares one design:
 *
 * - A full document with its own light page. The first HTML email had no background of its own, so
 *   the reader's client supplied one. On a dark-themed client (Zoho, 2 Oct 2026) navy text would have
 *   sat at about 1.3:1 and vanished. On this white card, navy and white-on-navy are both 12.6:1. The
 *   color-scheme metas ask Apple Mail and Outlook not to invert it.
 * - Built from tables, because Outlook ignores max-width on a div.
 * - A footer under the content: the Chronix banner, then a "Reach out to us" button.
 *   - The banner is hosted by the web app (apps/web/public/email/banner.png), never Supabase
 *     Storage: school-assets is going private, which would break every email already sent. It is
 *     public by design and in git. Its alt text is a readable line, because Outlook and much of
 *     Gmail block images by default.
 *   - The button is HTML, never part of the image, so it works with images off.
 *   - Its address comes from appBaseUrl() (the caller passes it), like every link the API sends.
 *
 * The plain-text part of an email carries none of this. A refused email is queued as text only
 * (email_queue has no HTML column), so its retry arrives without the banner.
 *
 * Not every email gets this page. It is for emails that speak for Chronix. An email a school sends
 * its parents (fee reminders, receipts, notifications) carries no Chronix advertising (decided
 * 2 Oct 2026).
 */

/**
 * Chronix navy, copied from apps/web/tailwind.config.ts (navy.DEFAULT; the API cannot import the web
 * config). Change it there and here together, and invent no shade. One flat colour per element:
 * email clients ignore :hover.
 */
export const BRAND_NAVY = '#003366';
export const EMAIL_PAGE_BACKGROUND = '#f4f5f7';
export const EMAIL_CARD_BACKGROUND = '#ffffff';
export const EMAIL_TEXT = '#111827';
export const BUTTON_LABEL = '#ffffff';

export const SUPPORT_EMAIL = 'support@chronixtechnology.com';

/** Served by the web app from apps/web/public/email/banner.png. The web must deploy it before any API change that names it. */
export const BANNER_PATH = '/email/banner.png';
export const BANNER_ALT = 'Chronix Edu — run the term, not the paperwork';
export const FOOTER_BUTTON_LABEL = 'Reach out to us';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A button that survives Outlook: the colour sits on a table cell (bgcolor and style both), so it
 * shows even where the client drops an anchor's padding or background.
 */
export function emailButton(href: string, label: string): string {
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">`,
    `<tr><td align="center" bgcolor="${BRAND_NAVY}" style="background-color:${BRAND_NAVY};border-radius:6px">`,
    `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;line-height:1.2;color:${BUTTON_LABEL};text-decoration:none;border-radius:6px">${escapeHtml(label)}</a>`,
    `</td></tr>`,
    `</table>`,
  ].join('\n');
}

export interface RenderEmailInput {
  /** The document title; some clients show it. Escaped here. */
  title: string;
  /** The email's own content, already HTML. The caller escapes anything a person typed. */
  bodyHtml: string;
  /** appBaseUrl(): the web app's public address, no trailing slash. */
  appUrl: string;
}

export function renderEmail({ title, bodyHtml, appUrl }: RenderEmailInput): string {
  const banner =
    `<a href="${escapeHtml(appUrl)}" style="display:block;text-decoration:none">` +
    `<img src="${escapeHtml(`${appUrl}${BANNER_PATH}`)}" width="600" alt="${escapeHtml(BANNER_ALT)}" ` +
    `style="max-width:100%;height:auto;display:block;border:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:${BRAND_NAVY}">` +
    `</a>`;

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light">`,
    `<meta name="supported-color-schemes" content="light">`,
    `<title>${escapeHtml(title)}</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background-color:${EMAIL_PAGE_BACKGROUND}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_PAGE_BACKGROUND}">`,
    `<tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${EMAIL_CARD_BACKGROUND};color:${EMAIL_TEXT};border-radius:8px;overflow:hidden">`,
    // Long addresses and URLs may break mid-word: unbroken, one (a school's email address, the login
    // link) set the card wider than a phone screen, and the card ran off its right edge.
    `<tr><td style="padding:32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${EMAIL_TEXT};word-break:break-word;overflow-wrap:anywhere">`,
    bodyHtml,
    `</td></tr>`,
    `<!-- footer -->`,
    // Centred so that, with images blocked, the alt text sits in the middle rather than against the
    // card's edge. A loaded image fills the 600px either way.
    `<tr><td align="center" style="padding:0;text-align:center">`,
    banner,
    `</td></tr>`,
    `<tr><td align="center" style="padding:24px 28px 32px">`,
    emailButton(`mailto:${SUPPORT_EMAIL}`, FOOTER_BUTTON_LABEL),
    `</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</body>`,
    `</html>`,
  ].join('\n');
}
