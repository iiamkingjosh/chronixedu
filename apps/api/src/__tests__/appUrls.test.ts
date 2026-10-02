/**
 * The web app's base URL has one source, APP_URL, and no default (2 Oct 2026). Eight separate
 * expressions with three fallbacks sent a new school's principal to http://localhost:3000, from a
 * leftover NEXTAUTH_URL, in the first email the school ever received.
 */
import fs from 'fs';
import path from 'path';
import { appBaseUrl, resetPasswordRedirect } from '../config/appUrls';
import { onboardingWelcomeEmail, BRAND_NAVY, EMAIL_CARD_BACKGROUND, EMAIL_PAGE_BACKGROUND, EMAIL_TEXT } from '../services/onboardingWelcomeEmail';
import { FOOTER_BUTTON_LABEL } from '../services/emailLayout';

/**
 * The email's buttons: white on navy, and labelled with an action rather than an address, so they
 * cannot contradict their link. "Reach out to us" joined "Set your password" when the shared layout's
 * footer arrived (emailLayout.test.ts covers it). Every link that shows an address must show its own.
 */
const BUTTONS = ['Set your password', FOOTER_BUTTON_LABEL];

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

describe('appBaseUrl', () => {
  const saved = { APP_URL: process.env.APP_URL, NEXTAUTH_URL: process.env.NEXTAUTH_URL };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('is APP_URL, without a trailing slash, and ignores NEXTAUTH_URL', () => {
    process.env.APP_URL = 'https://app.example.test/';
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    expect(appBaseUrl()).toBe('https://app.example.test');
    expect(resetPasswordRedirect()).toBe('https://app.example.test/reset-password');
  });

  it('refuses rather than defaults when APP_URL is unset, even with NEXTAUTH_URL set', () => {
    delete process.env.APP_URL;
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    expect(() => appBaseUrl()).toThrow(/APP_URL is not set/);
    expect(() => resetPasswordRedirect()).toThrow(/APP_URL is not set/);
  });

  it('is the only reader: nothing else in src reads APP_URL or NEXTAUTH_URL', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['__tests__', '__db_tests__'].includes(e.name)) walk(full); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const rel = path.relative(root, full).split(path.sep).join('/');
        const src = fs.readFileSync(full, 'utf8');
        if (/process\.env\.(APP_URL|NEXTAUTH_URL)\b|process\.env\[['"](APP_URL|NEXTAUTH_URL)['"]\]/.test(src) && rel !== 'config/appUrls.ts') offenders.push(rel);
        if (/NEXTAUTH_URL/.test(src) && rel !== 'config/appUrls.ts') offenders.push(`${rel} (names NEXTAUTH_URL)`);
      }
    };
    walk(root);
    // The control: the scanner does see the one reader it allows.
    expect(fs.readFileSync(path.join(root, 'config', 'appUrls.ts'), 'utf8')).toMatch(/process\.env\.APP_URL/);
    expect(offenders).toEqual([]);
  });
});

describe('the onboarding welcome email', () => {
  const link = 'https://pgnp.supabase.co/auth/v1/verify?token=abc&type=recovery&redirect_to=https://app.example.test/reset-password';
  const mail = onboardingWelcomeEmail({
    firstName: 'Ada <b>', principalEmail: 'ada@school.test', setPasswordLink: link, appUrl: 'https://app.example.test',
  });

  it('sends the principal to the web app, in both parts', () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('https://app.example.test/login');
      expect(part).toContain('https://app.example.test/legal');
      expect(part).not.toMatch(/localhost/);
    }
  });

  it('makes the set-password link a button whose target is the link exactly as generated; the text shows the URL', () => {
    expect(mail.text).toContain(`\n${link}\n`);
    const anchor = mail.html.match(/<a href="([^"]+)"[^>]*>Set your password<\/a>/);
    expect(anchor).not.toBeNull();
    // Attribute escaping only: once the HTML is parsed, the target is the link itself.
    expect(anchor![1].replace(/&amp;/g, '&')).toBe(link);
  });

  it('every other link shows its own address as its text, so text and destination never differ', () => {
    const anchors = [...mail.html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].filter(m => !BUTTONS.includes(m[2]));
    expect(anchors.length).toBeGreaterThan(0);
    for (const [, href, label] of anchors) expect(href.replace(/^mailto:/, '')).toBe(label);
  });

  it("uses Chronix navy for the button and for every other link, never the client's default blue", () => {
    expect(BRAND_NAVY).toBe('#003366'); // navy.DEFAULT in apps/web/tailwind.config.ts
    const button = mail.html.match(/<a href="[^"]+" style="([^"]*)">Set your password<\/a>/);
    expect(button).not.toBeNull();
    expect(button![1]).toMatch(/(^|;)background:#003366;/);
    const others = [...mail.html.matchAll(/<a ([^>]*)>([^<]+)<\/a>/g)].filter(m => !BUTTONS.includes(m[2]));
    expect(others.length).toBeGreaterThan(0);
    for (const [, attrs, label] of others) expect({ label, colour: attrs.match(/style="color:(#[0-9A-Fa-f]{6})"/)?.[1] }).toEqual({ label, colour: '#003366' });
  });

  it('brings its own light page, so its colours do not depend on the reader\'s dark mode', () => {
    // No background of its own meant the client supplied one: on a dark theme, navy would vanish.
    expect(mail.html).toMatch(/^<!doctype html>/);
    expect(mail.html).toContain('<meta name="color-scheme" content="light">');
    expect(mail.html).toContain('<meta name="supported-color-schemes" content="light">');
    expect(mail.html).toContain(`<body style="margin:0;padding:0;background-color:${EMAIL_PAGE_BACKGROUND}">`);
    const card = mail.html.indexOf(`background-color:${EMAIL_CARD_BACKGROUND};color:${EMAIL_TEXT}`);
    expect(card).toBeGreaterThan(0);
    // The content, button included, sits inside the white card.
    expect(mail.html.indexOf('Set your password')).toBeGreaterThan(card);
    expect(mail.html.indexOf('Hi Ada')).toBeGreaterThan(card);
  });

  it('every colour pairing in it reads at WCAG AA or better', () => {
    expect(EMAIL_CARD_BACKGROUND).toBe('#ffffff');
    expect(contrast(BRAND_NAVY, EMAIL_CARD_BACKGROUND)).toBeGreaterThanOrEqual(4.5); // links on the card
    expect(contrast('#ffffff', BRAND_NAVY)).toBeGreaterThanOrEqual(4.5); // the button's label
    // The footer's "Reach out to us", read from the email as rendered: its cell's colour, its label's colour.
    const footer = mail.html.match(new RegExp(`<td align="center" bgcolor="(#[0-9a-fA-F]{6})"[^>]*>\\s*<a [^>]*color:(#[0-9a-fA-F]{6});[^>]*>${FOOTER_BUTTON_LABEL}</a>`));
    expect(footer).not.toBeNull();
    expect(contrast(footer![2], footer![1])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(EMAIL_TEXT, EMAIL_CARD_BACKGROUND)).toBeGreaterThanOrEqual(4.5); // body text
    // The calculator's control: the measured failures that started this read as failures.
    expect(contrast(BRAND_NAVY, '#222222')).toBeLessThan(1.5); // navy on a dark client background
    expect(contrast('#ffffff', '#FF761B')).toBeLessThan(3); // white on orange
  });

  it('escapes what an operator typed', () => {
    expect(mail.html).toContain('Hi Ada &lt;b&gt;,');
    expect(mail.html).not.toContain('Ada <b>');
  });
});
