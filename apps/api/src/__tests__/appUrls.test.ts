/**
 * The web app's base URL has one source, APP_URL, and no default (2 Oct 2026). Eight separate
 * expressions with three fallbacks sent a new school's principal to http://localhost:3000, from a
 * leftover NEXTAUTH_URL, in the first email the school ever received.
 */
import fs from 'fs';
import path from 'path';
import { appBaseUrl, resetPasswordRedirect } from '../config/appUrls';
import { onboardingWelcomeEmail } from '../services/onboardingWelcomeEmail';

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
    const anchors = [...mail.html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].filter(m => m[2] !== 'Set your password');
    expect(anchors.length).toBeGreaterThan(0);
    for (const [, href, label] of anchors) expect(href.replace(/^mailto:/, '')).toBe(label);
  });

  it('escapes what an operator typed', () => {
    expect(mail.html).toContain('Hi Ada &lt;b&gt;,');
    expect(mail.html).not.toContain('Ada <b>');
  });
});
