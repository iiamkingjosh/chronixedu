/**
 * Item H2 (1 Oct 2026): a screen that says "we emailed them" must be true. sendEmail never throws (a
 * refused send is logged and queued), and it used to return nothing, so every caller counted a
 * refused send as sent. It now says what happened, and sendWelcomeEmails names the addresses that did
 * not go. Resend's SDK, the queue and the database are mocked; nothing leaves the process.
 *
 * The SDK is replaced, not services/emailProvider.ts, so the provider's own code runs. Resend answers
 * `{ data, error }` and never throws for a refusal, so a refusal here is a resolved answer, as it is from
 * the real SDK (resend 6.32): code that waited for an exception would count every one of these as sent.
 */
jest.mock('resend', () => {
  const send = jest.fn();
  return { Resend: jest.fn(() => ({ emails: { send } })), __send: send };
});
jest.mock('../db/queries/emailQueue', () => ({ enqueueEmail: jest.fn() }));
jest.mock('../db/client', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: { auth: { admin: { getUserById: jest.fn() } } } }));

/** The Supabase Auth identities that exist, by id. */
const IDENTITIES: Record<string, string> = { u1: 'one@example.test', u2: 'two@example.test', u9: 'someone-else@example.test' };

type Mods = {
  resend: { send: jest.Mock; Resend: jest.Mock };
  queue: { enqueueEmail: jest.Mock };
  pool: { query: jest.Mock };
  logger: { error: jest.Mock; warn: jest.Mock };
  auth: { getUserById: jest.Mock };
  emailService: typeof import('../services/emailService');
  welcome: typeof import('../services/welcomeEmail');
};

/** Resend accepting an email, and refusing one, as the SDK answers. */
const ACCEPTED = { data: { id: 'email-id-1' }, error: null, headers: null };
const refused = (name: string, statusCode: number | null, message = name) => ({ data: null, error: { name, statusCode, message }, headers: null });

/** The provider reads RESEND_API_KEY and RESEND_FROM_EMAIL when it loads, so each case loads it afresh.
 *  The key is a placeholder: Resend itself is mocked. */
function load(key: string | undefined): Mods {
  const saved = { key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL };
  if (key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = key;
  process.env.RESEND_FROM_EMAIL = 'no-reply@notify.example.test';
  let mods!: Mods;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    mods = {
      resend: { send: require('resend').__send, Resend: require('resend').Resend },
      queue: require('../db/queries/emailQueue'),
      pool: require('../db/client').default,
      logger: require('../config/logger').logger,
      emailService: require('../services/emailService'),
      welcome: require('../services/welcomeEmail'),
      auth: require('../supabaseClient').supabaseAdmin.auth.admin,
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
  });
  mods.auth.getUserById.mockImplementation(async (id: string) => (IDENTITIES[id]
    ? { data: { user: { id, email: IDENTITIES[id] } }, error: null }
    : { data: { user: null }, error: { message: 'User not found', status: 404 } }));
  if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
  if (saved.from === undefined) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = saved.from;
  return mods;
}

describe('sendEmail says what became of the email', () => {
  it("'sent' when Resend accepts it, from the configured sender", async () => {
    const m = load('placeholder-not-a-key');
    m.resend.send.mockResolvedValueOnce(ACCEPTED);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('sent');
    expect(m.queue.enqueueEmail).not.toHaveBeenCalled();
    expect(m.resend.send).toHaveBeenCalledWith(expect.objectContaining({ from: 'Chronix Edu <no-reply@notify.example.test>', to: 'a@example.test' }));
  });

  it("'queued', never 'sent', when Resend answers with an error instead of throwing", async () => {
    const m = load('placeholder-not-a-key');
    m.resend.send.mockResolvedValueOnce(refused('invalid_api_key', 403, 'API key is invalid'));
    m.queue.enqueueEmail.mockResolvedValueOnce(undefined);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('queued');
    expect(m.queue.enqueueEmail).toHaveBeenCalledTimes(1);
  });

  it("'lost' when Resend refuses it and the queue write fails too", async () => {
    const m = load('placeholder-not-a-key');
    m.resend.send.mockResolvedValueOnce(refused('invalid_api_key', 403, 'API key is invalid'));
    m.queue.enqueueEmail.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('lost');
    expect(m.logger.error).toHaveBeenCalledWith('email_queue_insert_failed', expect.anything());
  });

  it("'disabled' when no key is set, and nothing is tried: no client is made, as the SDK throws without a key", async () => {
    const m = load(undefined);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('disabled');
    expect(m.resend.send).not.toHaveBeenCalled();
    expect(m.resend.Resend).not.toHaveBeenCalled();
  });

  it("'queued', not 'sent', when Resend answers with neither an error nor an email id", async () => {
    const m = load('placeholder-not-a-key');
    m.resend.send.mockResolvedValueOnce({ data: {}, error: null, headers: null });
    m.queue.enqueueEmail.mockResolvedValueOnce(undefined);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('queued');
  });

  it('a burst refusal (429 rate_limit_exceeded) is queued, not lost, and uses one of its tries', async () => {
    const m = load('placeholder-not-a-key');
    m.resend.send.mockResolvedValueOnce(refused('rate_limit_exceeded', 429, 'Too many requests'));
    m.queue.enqueueEmail.mockResolvedValueOnce(undefined);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('queued');
    expect(m.queue.enqueueEmail).toHaveBeenCalledWith('a@example.test', 's', 'b', expect.stringContaining('rate_limit_exceeded (429)'), 1);
    expect(m.logger.error).toHaveBeenCalledWith('email_send_failed', expect.objectContaining({ error: expect.stringContaining('rate_limit_exceeded') }));
  });

  it('a spent quota is queued without using a try, raises the quota alert, and is not logged as a failure', async () => {
    const m = load('placeholder-not-a-key');
    m.resend.send.mockResolvedValueOnce(refused('daily_quota_exceeded', 429, 'You have reached your daily email sending quota'));
    m.queue.enqueueEmail.mockResolvedValue(undefined);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('queued');
    expect(m.queue.enqueueEmail).toHaveBeenCalledWith('a@example.test', 's', 'b', expect.stringContaining('daily_quota_exceeded'), 0);
    expect(m.logger.error).toHaveBeenCalledWith('email_quota_exhausted', expect.objectContaining({ held_minutes: 15 }));
    expect(m.logger.error).not.toHaveBeenCalledWith('email_send_failed', expect.anything());
    expect(m.logger.warn).toHaveBeenCalledWith('email_send_held', expect.anything());
    // The next email is held without asking Resend: one call to Resend in all.
    await expect(m.emailService.sendEmail('b@example.test', 's', 'b')).resolves.toBe('queued');
    expect(m.resend.send).toHaveBeenCalledTimes(1);
    expect(m.queue.enqueueEmail).toHaveBeenLastCalledWith('b@example.test', 's', 'b', expect.stringContaining('quota_held'), 0);
  });
});

describe('sendWelcomeEmails names the addresses that did not go', () => {
  const people = [
    { userId: 'u1', email: 'one@example.test', name: 'One', role: 'parent' },
    { userId: 'u2', email: 'two@example.test', name: 'Two', role: 'parent' },
  ];

  it("'sent' only when Resend accepts every one", async () => {
    const m = load('placeholder-not-a-key');
    m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] });
    m.resend.send.mockResolvedValue(ACCEPTED);
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome')).resolves.toEqual({ outcome: 'sent', not_sent: [] });
    expect(m.resend.send).toHaveBeenCalledTimes(2);
    // Each account's login was checked before it was mailed.
    expect(m.auth.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(['u1', 'u2']);
    expect(m.logger.error).not.toHaveBeenCalledWith('welcome_email_failed', expect.anything());
  });

  it("'partly_sent', naming the refused address, and raises the alert with counts only", async () => {
    const m = load('placeholder-not-a-key');
    m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] });
    m.resend.send.mockImplementation(async (msg: { to: string }) => {
      if (msg.to === 'two@example.test') return refused('validation_error', 422, 'Invalid to field');
      return ACCEPTED;
    });
    m.queue.enqueueEmail.mockResolvedValue(undefined);
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome')).resolves.toEqual({ outcome: 'partly_sent', not_sent: ['two@example.test'] });

    const failed = m.logger.error.mock.calls.filter(([event]) => event === 'welcome_email_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ stage: 'send', not_sent: 1, of: 2, outcomes: JSON.stringify({ sent: 1, queued: 1 }) });
    expect(JSON.stringify(failed[0][1])).not.toContain('@');
  });

  it("'not_sent', naming everyone, when preparing the emails fails", async () => {
    const m = load('placeholder-not-a-key');
    m.pool.query.mockRejectedValue(new Error('connection terminated'));
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome'))
      .resolves.toEqual({ outcome: 'not_sent', not_sent: ['one@example.test', 'two@example.test'] });
    expect(m.resend.send).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledWith('welcome_email_failed', expect.objectContaining({ stage: 'prepare' }));
  });

  it("'not_sent', naming everyone, when email is not configured on the server", async () => {
    const m = load(undefined);
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome'))
      .resolves.toEqual({ outcome: 'not_sent', not_sent: ['one@example.test', 'two@example.test'] });
    expect(m.logger.warn).toHaveBeenCalledWith('welcome_email_skipped_unconfigured', expect.objectContaining({ count: 2 }));
  });

  it("'none' when no new account needs one", async () => {
    const m = load('placeholder-not-a-key');
    await expect(m.welcome.sendWelcomeEmails('school', [], 'Welcome')).resolves.toEqual({ outcome: 'none', not_sent: [] });
    expect(m.resend.send).not.toHaveBeenCalled();
  });

  it('works through a long list five accounts at a time, and still mails every one', async () => {
    const m = load('placeholder-not-a-key');
    m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] });
    m.resend.send.mockResolvedValue(ACCEPTED);
    const seven = Array.from({ length: 7 }, (_, n) => ({ userId: `p${n}`, email: `p${n}@example.test`, name: `P${n}`, role: 'parent' }));
    let inFlight = 0;
    let most = 0;
    m.auth.getUserById.mockImplementation(async (id: string) => {
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { data: { user: { id, email: `${id}@example.test` } }, error: null };
    });

    await expect(m.welcome.sendWelcomeEmails('school', seven, 'Welcome')).resolves.toEqual({ outcome: 'sent', not_sent: [] });
    // Five at once, not fifty and not one: seven accounts make a first batch of exactly five.
    expect(most).toBe(m.welcome.WELCOME_EMAIL_BATCH_SIZE);
    expect(m.welcome.WELCOME_EMAIL_BATCH_SIZE).toBe(5);
    expect(m.resend.send).toHaveBeenCalledTimes(7);
  });
});

describe('an account that cannot sign in is never told to use Forgot password', () => {
  // Forgot password answers the same 200 for every address (Round 24), so an account with no Supabase
  // Auth identity told to use it would get a success message and no email, every time, and nothing
  // would log it. The welcome path refuses instead, names the address, and raises an alert.
  const people = [
    { userId: 'u1', email: 'one@example.test', name: 'One', role: 'parent' },
    { userId: 'u2', email: 'two@example.test', name: 'Two', role: 'parent' },
  ];
  const ready = () => { const m = load('placeholder-not-a-key'); m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] }); m.resend.send.mockResolvedValue(ACCEPTED); return m; };

  it('does not mail an account with no Auth identity, names it, and raises account_cannot_sign_in', async () => {
    const m = ready();
    const noLogin = { userId: 'u3', email: 'three@example.test', name: 'Three', role: 'parent' };
    await expect(m.welcome.sendWelcomeEmails('school', [people[0], noLogin], 'Welcome'))
      .resolves.toEqual({ outcome: 'partly_sent', not_sent: ['three@example.test'] });
    expect(m.resend.send.mock.calls.map(([msg]) => msg.to)).toEqual(['one@example.test']);
    expect(m.logger.error).toHaveBeenCalledWith('welcome_email_no_login', expect.objectContaining({ not_sent: 1, of: 2 }));
    expect(m.logger.error).not.toHaveBeenCalledWith('welcome_email_failed', expect.anything());
  });

  it('does not mail an account whose Auth identity holds a different address', async () => {
    const m = ready();
    const mismatched = { userId: 'u9', email: 'four@example.test', name: 'Four', role: 'parent' };
    await expect(m.welcome.sendWelcomeEmails('school', [mismatched], 'Welcome'))
      .resolves.toEqual({ outcome: 'not_sent', not_sent: ['four@example.test'] });
    expect(m.resend.send).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledWith('welcome_email_no_login', expect.objectContaining({ not_sent: 1, of: 1 }));
  });

  it('does not mail what it could not check, and says the check failed', async () => {
    const m = ready();
    m.auth.getUserById.mockRejectedValue(new Error('other side closed'));
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome'))
      .resolves.toEqual({ outcome: 'not_sent', not_sent: ['one@example.test', 'two@example.test'] });
    expect(m.resend.send).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledWith('welcome_email_failed', expect.objectContaining({ stage: 'verify', not_sent: 2, error: 'other side closed' }));
    expect(m.logger.error).not.toHaveBeenCalledWith('welcome_email_no_login', expect.anything());
  });
});

describe('the welcome email carries no credential', () => {
  it('says the account is ready and how to set a password, and nothing that signs anyone in', () => {
    const { welcome } = load(undefined);
    const body = welcome.welcomeEmailBody({ role: 'parent', name: 'Ngozi Eze', email: 'ngozi@example.test', schoolName: 'Test School', appUrl: 'https://app.example.test' });
    expect(body).toContain('Your account is ready. Your login email is ngozi@example.test.');
    expect(body).toContain('https://app.example.test/forgot-password');
    expect(body).toContain('Enter ngozi@example.test');
    expect(body).not.toMatch(/password:[ \t]*\S/i);
    expect(body).not.toMatch(/temporary password|token=|access_token|type=recovery/i);
  });
});
