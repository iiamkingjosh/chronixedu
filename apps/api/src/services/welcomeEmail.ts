import pool from '../db/client';
import { supabaseAdmin } from '../supabaseClient';
import { sendEmail, isEmailConfigured } from './emailService';
import { logger } from '../config/logger';

export async function getSchoolName(schoolId: string): Promise<string> {
  const r = await pool.query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolId]);
  return r.rows[0]?.name ?? 'your school';
}

export interface WelcomeEmailOptions {
  role: string;
  name: string;
  email: string;
  schoolName: string;
  appUrl: string;
  /** How the role is introduced. 'registered' (Students & Parents' wording,
   *  the default) reads "You have been registered on Chronix Edu as a X for
   *  Y."; 'added' (Staff/Users' wording) reads "You have been added as a X
   *  on Chronix Edu for Y." */
  introVerb?: 'registered' | 'added';
  /** Extra line after the set-your-password steps, e.g. the Parent Portal description. */
  extraLine?: string;
}

/**
 * The welcome email for a new staff or parent account. Since 1 Oct 2026 (item H2, option (iii),
 * decided by Moses) it carries NO password and NO link: it says the account exists and how to set a
 * password with "Forgot password", which sends a link to this same address. Nothing in it can be
 * used to sign in, and nothing in it expires. It used to print the temporary password.
 *
 * This does not protect against a mistyped address (whoever reads the mail can use Forgot password);
 * that is the job of the double entry (single parent) and the address check before a bulk commit.
 */
export function welcomeEmailBody(opts: WelcomeEmailOptions): string {
  const { role, name, email, schoolName, appUrl, extraLine, introVerb = 'registered' } = opts;
  const intro = introVerb === 'registered'
    ? `You have been registered on Chronix Edu as a ${role} for ${schoolName}.`
    : `You have been added as a ${role} on Chronix Edu for ${schoolName}.`;
  return [
    `Hello ${name},`,
    '',
    intro,
    '',
    `Your account is ready. Your login email is ${email}.`,
    '',
    'To set your password:',
    `  1. Go to ${appUrl}/forgot-password`,
    `  2. Enter ${email}`,
    '  3. Open the link we send to this address and choose your password.',
    '',
    `Then log in at ${appUrl}/login.`,
    ...(extraLine ? ['', extraLine] : []),
    '',
    'If you did not expect this email, please contact your school administrator.',
    '',
    '— Chronix Edu',
  ].join('\n');
}

/** What became of a set of welcome emails, for the response to say plainly. */
export type WelcomeEmailOutcome = 'sent' | 'partly_sent' | 'not_sent' | 'none';

export interface WelcomeEmailReport {
  outcome: WelcomeEmailOutcome;
  /** The addresses whose email did not go, for the screen to name. Empty when outcome is 'sent' or 'none'. */
  not_sent: string[];
}

const WELCOME_EMAIL_BATCH_SIZE = 50;

/** A new account to welcome. `userId` is its `users.id`, which is also its Supabase Auth id. */
export interface WelcomeRecipient { userId: string; email: string; name: string; role: string }

/**
 * Whether this account can sign in: Supabase Auth holds an identity with its id AND its address.
 * Signing in (`signInWithPassword`, then the local row by that id) and Forgot password both need it.
 * The welcome email's whole instruction is "use Forgot password", and Forgot password answers the
 * same 200 for every address (Round 24). So an account without an identity would be told to reset a
 * password that does not exist, get a success message and no email every time, and nothing would
 * log it, because nothing failed. Every path that mails today creates the identity first; this is the
 * check that keeps a future one honest. Asked through the Auth admin API, the authority itself, not
 * by reading `auth.users`, which the C-4a app role cannot see.
 */
async function signInCheck(r: WelcomeRecipient): Promise<{ state: 'yes' | 'no' | 'unknown'; error?: string }> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(r.userId);
    if (data?.user) return { state: (data.user.email ?? '').toLowerCase() === r.email.toLowerCase() ? 'yes' : 'no' };
    if (error && ((error as { status?: number }).status === 404 || /not found/i.test(error.message))) return { state: 'no' };
    return { state: 'unknown', error: error?.message ?? 'no user and no error' };
  } catch (err) {
    return { state: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Sends the welcome email to each new account and says what happened, so the response tells the
 * operator what the logs and alerts know:
 * - 'sent': SendGrid accepted every one;
 * - 'partly_sent' / 'not_sent': some / none went, and `not_sent` names the addresses. A refused send
 *   is queued and retried, so it may still arrive, but nobody should be told it has. Any of these
 *   logs welcome_email_failed and raises the welcome_email_not_sent alert, so the alert and the
 *   operator's screen agree. Email not configured on this server is a warning, not an alert;
 * - 'none': no new account needed one.
 * Awaited, not fire-and-forget: it used to run after the response, so its failures reached the logs
 * and never the person who had just created the accounts. And sendEmail used to return nothing,
 * which counted a refused send as sent.
 */
export async function sendWelcomeEmails(
  schoolId: string,
  recipients: WelcomeRecipient[],
  subject: string,
  opts: { introVerb?: 'registered' | 'added'; extraLine?: string } = {}
): Promise<WelcomeEmailReport> {
  if (recipients.length === 0) return { outcome: 'none', not_sent: [] };
  const everyone: WelcomeEmailReport = { outcome: 'not_sent', not_sent: recipients.map(r => r.email) };
  if (!isEmailConfigured()) {
    logger.warn('welcome_email_skipped_unconfigured', { school_id: schoolId, count: recipients.length });
    return everyone;
  }
  let schoolName: string;
  try {
    schoolName = await getSchoolName(schoolId);
  } catch (err) {
    logger.error('welcome_email_failed', { school_id: schoolId, stage: 'prepare', error: err instanceof Error ? err.message : String(err) });
    return everyone;
  }
  const appUrl = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const notSent: string[] = [];
  const outcomes: Record<string, number> = {};
  let noLogin = 0;
  let unverified = 0;
  let verifyError = '';
  for (let i = 0; i < recipients.length; i += WELCOME_EMAIL_BATCH_SIZE) {
    const candidates = recipients.slice(i, i + WELCOME_EMAIL_BATCH_SIZE);
    // An account that cannot sign in is never told to use Forgot password; it is named as not sent.
    const checks = await Promise.all(candidates.map(signInCheck));
    const batch = candidates.filter((r, n) => {
      if (checks[n].state === 'yes') return true;
      notSent.push(r.email);
      if (checks[n].state === 'no') noLogin += 1;
      else { unverified += 1; verifyError = checks[n].error ?? verifyError; }
      return false;
    });
    const results = await Promise.all(batch.map(r => sendEmail(
      r.email,
      subject,
      welcomeEmailBody({ role: r.role, name: r.name, email: r.email, schoolName, appUrl, ...opts }),
    ).catch(err => {
      // sendEmail does not throw today; if it ever does, this email did not go and the report says so.
      logger.error('welcome_email_failed', { school_id: schoolId, stage: 'send', error: err instanceof Error ? err.message : String(err) });
      return 'lost' as const;
    })));
    batch.forEach((r, n) => {
      outcomes[results[n]] = (outcomes[results[n]] ?? 0) + 1;
      if (results[n] !== 'sent') notSent.push(r.email);
    });
    if (i + WELCOME_EMAIL_BATCH_SIZE < recipients.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  if (notSent.length === 0) return { outcome: 'sent', not_sent: [] };
  // Counts only: the addresses are already in sendgrid_email_failed, which is not forwarded.
  if (noLogin) logger.error('welcome_email_no_login', { school_id: schoolId, not_sent: noLogin, of: recipients.length });
  if (unverified) logger.error('welcome_email_failed', { school_id: schoolId, stage: 'verify', not_sent: unverified, of: recipients.length, error: verifyError });
  const refused = notSent.length - noLogin - unverified;
  if (refused) logger.error('welcome_email_failed', { school_id: schoolId, stage: 'send', not_sent: refused, of: recipients.length, outcomes: JSON.stringify(outcomes) });
  return { outcome: notSent.length === recipients.length ? 'not_sent' : 'partly_sent', not_sent: notSent };
}
