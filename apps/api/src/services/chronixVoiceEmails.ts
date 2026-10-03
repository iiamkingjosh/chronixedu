/**
 * Two emails that speak for Chronix itself, built on the shared layout (emailLayout.ts) so they carry
 * the banner (2 Oct 2026; the staff and parent welcome is in welcomeEmail.ts, the principal's in
 * onboardingWelcomeEmail.ts). Each returns the plain-text part and the HTML part with the same words.
 */
import sanitizeHtml from 'sanitize-html';
import { renderEmail, escapeHtml, EMAIL_TEXT } from './emailLayout';

/** Plain text in paragraphs: a blank line starts a new one, a single line break stays a line break. */
function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * The announcement's body as plain text. A platform admin writes it, and it has always been reduced to
 * plain text before sending. sanitize-html escapes the text it keeps ("&" becomes "&amp;"), and that
 * output went out as the plain-text email, so a principal read "Fees &amp; dues". Decoded back here,
 * ampersand last so "&amp;lt;" stays the literal text "&lt;". The HTML part escapes it again for itself.
 */
export function announcementPlainText(body: string): string {
  return sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .trim();
}

/** The email a published platform announcement sends each matching principal. */
export function platformAnnouncementEmail({ title, body, appUrl }: { title: string; body: string; appUrl: string }): { text: string; html: string } {
  const text = announcementPlainText(body);
  const bodyHtml = [
    `<h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:${EMAIL_TEXT}">${escapeHtml(title)}</h2>`,
    paragraphs(text),
  ].join('\n');
  return { text, html: renderEmail({ title, bodyHtml, appUrl }) };
}

export const TEST_EMAIL_SUBJECT = 'Chronix Edu — Test Email';

/** The test email a school sends itself from Settings → Notifications, so it shows the real design. */
export function testEmail(appUrl: string): { text: string; html: string } {
  const text = 'This is a test email from Chronix Edu confirming your SendGrid configuration is working correctly.';
  return { text, html: renderEmail({ title: TEST_EMAIL_SUBJECT, bodyHtml: paragraphs(text), appUrl }) };
}
