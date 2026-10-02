/**
 * The shared page for emails in Chronix's own voice (emailLayout.ts, 2 Oct 2026), and the banner it
 * shows. The banner is pinned by hash: on 2 Oct the version with an acquisition button ("Set up your
 * school") was saved under the approved file's name, and only its size gave it away. A wrong file now
 * fails the build instead of reaching every inbox.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  renderEmail, emailButton, BANNER_ALT, BANNER_PATH, BRAND_NAVY, BUTTON_LABEL, EMAIL_CARD_BACKGROUND,
  EMAIL_PAGE_BACKGROUND, EMAIL_TEXT, FOOTER_BUTTON_LABEL, SUPPORT_EMAIL,
} from '../services/emailLayout';

/** WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const APP = 'https://app.example.test';
const html = renderEmail({ title: 'A <title>', bodyHtml: '<p>THE BODY</p>', appUrl: APP });

describe('renderEmail', () => {
  it('is a whole light page: its own metas, background and a white card holding the body', () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light">');
    expect(html).toContain('<title>A &lt;title&gt;</title>');
    expect(html).toContain(`<body style="margin:0;padding:0;background-color:${EMAIL_PAGE_BACKGROUND}">`);
    const card = html.indexOf(`max-width:600px;background-color:${EMAIL_CARD_BACKGROUND};color:${EMAIL_TEXT}`);
    expect(card).toBeGreaterThan(0);
    expect(html.indexOf('<p>THE BODY</p>')).toBeGreaterThan(card);
  });

  it('puts the banner under the body: 600 wide, scaling down, linked to the app, with readable alt text', () => {
    const imgs = [...html.matchAll(/<img [^>]*>/g)].map(m => m[0]);
    expect(imgs).toHaveLength(1);
    const img = imgs[0];
    expect(img).toContain(`src="${APP}${BANNER_PATH}"`);
    expect(BANNER_PATH).toBe('/email/banner.png');
    expect(img).toContain('width="600"');
    expect(img).toMatch(/style="max-width:100%;height:auto;display:block;/);
    expect(BANNER_ALT).toBe('Chronix Edu — run the term, not the paperwork');
    expect(img).toContain(`alt="${BANNER_ALT}"`);
    // Linked to the app, and after the body.
    expect(html).toMatch(new RegExp(`<a href="${APP}"[^>]*><img `));
    expect(html.indexOf('<img ')).toBeGreaterThan(html.indexOf('<p>THE BODY</p>'));
  });

  it('follows the address it is given, so the banner follows APP_URL rather than a literal host', () => {
    const other = renderEmail({ title: 't', bodyHtml: '', appUrl: 'https://elsewhere.example.test' });
    expect(other).toContain('src="https://elsewhere.example.test/email/banner.png"');
    expect(other).not.toContain(APP);
    // The module names no host of its own.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'emailLayout.ts'), 'utf8');
    expect(src).not.toMatch(/https?:\/\/(?!\$\{)[a-z]/i);
  });

  it('ends with "Reach out to us": an HTML button to support, white on navy, after the banner', () => {
    const button = html.match(new RegExp(
      `<td align="center" bgcolor="(#[0-9a-fA-F]{6})" style="background-color:(#[0-9a-fA-F]{6});[^"]*">\\s*` +
      `<a href="([^"]+)" style="([^"]*)">${FOOTER_BUTTON_LABEL}</a>`));
    expect(button).not.toBeNull();
    const [, bgcolor, background, href, style] = button!;
    expect({ bgcolor, background }).toEqual({ bgcolor: BRAND_NAVY, background: BRAND_NAVY });
    expect(href).toBe(`mailto:${SUPPORT_EMAIL}`);
    expect(SUPPORT_EMAIL).toBe('support@chronixtechnology.com');
    expect(style).toContain(`color:${BUTTON_LABEL};`);
    expect(contrast(BUTTON_LABEL, BRAND_NAVY)).toBeGreaterThanOrEqual(4.5);
    expect(html.indexOf(FOOTER_BUTTON_LABEL)).toBeGreaterThan(html.indexOf('<img '));
  });

  it('escapes a button\'s address and label', () => {
    expect(emailButton('https://x.test/?a=1&b="2"', 'A <b>')).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
    expect(emailButton('https://x.test', 'A <b>')).toContain('>A &lt;b&gt;</a>');
  });
});

describe('the banner file', () => {
  const file = path.join(__dirname, '..', '..', '..', 'web', 'public', 'email', 'banner.png');

  it('is the approved image: the version without the "Set up your school" button', () => {
    const bytes = fs.readFileSync(file);
    // A PNG, 600x300, as the layout's width="600" assumes.
    expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([600, 300]);
    expect(bytes.length).toBeLessThanOrEqual(100 * 1024);
    // Pinned: changing the banner is deliberate, so it comes with a new hash in the same commit.
    expect(crypto.createHash('sha256').update(bytes).digest('hex'))
      .toBe('2b95649dfdcb3fb5174c326cfda73a129d3c4194d0740a903ab492b52ba71350');
  });
});
