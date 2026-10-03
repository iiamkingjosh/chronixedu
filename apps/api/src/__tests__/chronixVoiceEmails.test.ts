/**
 * The builders for the emails that speak for Chronix (2 Oct 2026): the staff and parent welcome's HTML
 * twin, the platform announcement and the test email. Each HTML part sits on the shared layout; each
 * plain-text part says the same thing.
 */
// welcomeEmail.ts also sends, so it loads the Supabase client and the database pool. Neither is used
// here, and CI's unit job runs with no credentials, where the Supabase client refuses to load.
jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: {} }));
jest.mock('../db/client', () => ({ __esModule: true, default: { query: jest.fn() } }));

import { welcomeEmailBody, welcomeEmailHtml } from '../services/welcomeEmail';
import { announcementPlainText, platformAnnouncementEmail, testEmail } from '../services/chronixVoiceEmails';

const APP = 'https://app.example.test';
const BANNER = `src="${APP}/email/banner.png"`;

describe('the staff and parent welcome', () => {
  const opts = { role: 'parent', name: 'Ngozi <Eze>', email: 'ngozi@example.test', schoolName: 'St. Mary\'s & "Co" <Academy>', appUrl: APP };

  it('keeps its plain text word for word', () => {
    // Pinned: the HTML twin moved the intro sentence into a shared function, and the text must not move.
    expect(welcomeEmailBody(opts)).toBe([
      'Hello Ngozi <Eze>,',
      '',
      'You have been registered on Chronix Edu as a parent for St. Mary\'s & "Co" <Academy>.',
      '',
      'Your account is ready. Your login email is ngozi@example.test.',
      '',
      'To set your password:',
      `  1. Go to ${APP}/forgot-password`,
      '  2. Enter ngozi@example.test',
      '  3. Open the link we send to this address and choose your password.',
      '',
      `Then log in at ${APP}/login.`,
      '',
      'If you did not expect this email, please contact your school administrator.',
      '',
      '— Chronix Edu',
    ].join('\n'));
    expect(welcomeEmailBody({ ...opts, role: 'teacher', introVerb: 'added' }))
      .toContain('You have been added as a teacher on Chronix Edu for St. Mary\'s & "Co" <Academy>.');
  });

  it('as HTML: on the layout, everything a school typed escaped, its links shown as their own addresses', () => {
    const html = welcomeEmailHtml({ ...opts, extraLine: 'Use the <Parent Portal> & more.' }, 'Welcome & more');
    expect(html).toContain(BANNER);
    expect(html).toContain('<title>Welcome &amp; more</title>');
    expect(html).toContain('<p>Hello Ngozi &lt;Eze&gt;,</p>');
    expect(html).toContain('as a parent for St. Mary&#39;s &amp; &quot;Co&quot; &lt;Academy&gt;.</p>');
    expect(html).toContain('<p>Use the &lt;Parent Portal&gt; &amp; more.</p>');
    expect(html).not.toMatch(/<Eze>|<Academy>|<Parent Portal>/);
    for (const url of [`${APP}/forgot-password`, `${APP}/login`]) {
      expect(html).toContain(`<a href="${url}" style="color:#003366">${url}</a>`);
    }
  });
});

describe('the platform announcement', () => {
  it('as plain text: tags and scripts gone, and no escaping left behind', () => {
    // The control: the sanitiser alone leaves "&amp;" in what used to be sent as plain text.
    expect(announcementPlainText('a &amp;lt; b')).toBe('a &lt; b');
    expect(announcementPlainText('Fees & dues <b>due</b> "now"<script>x()</script>')).toBe('Fees & dues due "now"');
  });

  it('as HTML: a heading, paragraphs and line breaks kept, escaped, on the layout', () => {
    const mail = platformAnnouncementEmail({ title: 'A & <B>', body: 'One & two\nthree\n\n\nFour <i>five</i>', appUrl: APP });
    expect(mail.text).toBe('One & two\nthree\n\n\nFour five');
    expect(mail.html).toContain('>A &amp; &lt;B&gt;</h2>');
    expect(mail.html).toContain('<p>One &amp; two<br>three</p>\n<p>Four five</p>');
    expect(mail.html).toContain('<title>A &amp; &lt;B&gt;</title>');
    expect(mail.html).toContain(BANNER);
    expect(mail.html).not.toContain('<i>');
  });
});

describe('the test email', () => {
  it('keeps its words and comes on the layout, so a test shows the real design', () => {
    const mail = testEmail(APP);
    expect(mail.text).toBe('This is a test email from Chronix Edu confirming your SendGrid configuration is working correctly.');
    expect(mail.html).toContain(`<p>${mail.text}</p>`);
    expect(mail.html).toContain(BANNER);
    expect(mail.html).toContain('>Reach out to us</a>');
  });
});
