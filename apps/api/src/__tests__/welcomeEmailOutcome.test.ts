/**
 * Item H2 (1 Oct 2026): a screen that says "we emailed them" must be true. sendEmail never throws (a
 * refused send is logged and queued), and it used to return nothing, so every caller counted a
 * refused send as sent. It now says what happened, and sendWelcomeEmails names the addresses that did
 * not go. SendGrid, the queue and the database are mocked; nothing leaves the process.
 */
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('../db/queries/emailQueue', () => ({ enqueueEmail: jest.fn() }));
jest.mock('../db/client', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../supabaseClient', () => ({ supabase: {}, supabaseAdmin: { auth: { admin: { getUserById: jest.fn() } } } }));

/** The Supabase Auth identities that exist, by id. */
const IDENTITIES: Record<string, string> = { u1: 'one@example.test', u2: 'two@example.test', u9: 'someone-else@example.test' };

type Mods = {
  sgMail: { send: jest.Mock };
  queue: { enqueueEmail: jest.Mock };
  pool: { query: jest.Mock };
  logger: { error: jest.Mock; warn: jest.Mock };
  auth: { getUserById: jest.Mock };
  emailService: typeof import('../services/emailService');
  welcome: typeof import('../services/welcomeEmail');
};

/** emailService reads SENDGRID_API_KEY when it loads, so each case loads it afresh. The key is a
 *  placeholder: SendGrid itself is mocked. */
function load(key: string | undefined): Mods {
  const saved = process.env.SENDGRID_API_KEY;
  if (key === undefined) delete process.env.SENDGRID_API_KEY; else process.env.SENDGRID_API_KEY = key;
  let mods!: Mods;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    mods = {
      sgMail: require('@sendgrid/mail'),
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
  if (saved === undefined) delete process.env.SENDGRID_API_KEY; else process.env.SENDGRID_API_KEY = saved;
  return mods;
}

describe('sendEmail says what became of the email', () => {
  it("'sent' when SendGrid accepts it", async () => {
    const m = load('placeholder-not-a-key');
    m.sgMail.send.mockResolvedValueOnce([{ statusCode: 202 }]);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('sent');
    expect(m.queue.enqueueEmail).not.toHaveBeenCalled();
  });

  it("'queued' when SendGrid refuses it and the queue takes it", async () => {
    const m = load('placeholder-not-a-key');
    m.sgMail.send.mockRejectedValueOnce(new Error('403 Forbidden'));
    m.queue.enqueueEmail.mockResolvedValueOnce(undefined);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('queued');
    expect(m.queue.enqueueEmail).toHaveBeenCalledTimes(1);
  });

  it("'lost' when SendGrid refuses it and the queue write fails too", async () => {
    const m = load('placeholder-not-a-key');
    m.sgMail.send.mockRejectedValueOnce(new Error('403 Forbidden'));
    m.queue.enqueueEmail.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('lost');
    expect(m.logger.error).toHaveBeenCalledWith('email_queue_insert_failed', expect.anything());
  });

  it("'disabled' when no key is set, and nothing is tried", async () => {
    const m = load(undefined);
    await expect(m.emailService.sendEmail('a@example.test', 's', 'b')).resolves.toBe('disabled');
    expect(m.sgMail.send).not.toHaveBeenCalled();
  });
});

describe('sendWelcomeEmails names the addresses that did not go', () => {
  const people = [
    { userId: 'u1', email: 'one@example.test', name: 'One', role: 'parent' },
    { userId: 'u2', email: 'two@example.test', name: 'Two', role: 'parent' },
  ];

  it("'sent' only when SendGrid accepts every one", async () => {
    const m = load('placeholder-not-a-key');
    m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] });
    m.sgMail.send.mockResolvedValue([{ statusCode: 202 }]);
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome')).resolves.toEqual({ outcome: 'sent', not_sent: [] });
    expect(m.sgMail.send).toHaveBeenCalledTimes(2);
    // Each account's login was checked before it was mailed.
    expect(m.auth.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(['u1', 'u2']);
    expect(m.logger.error).not.toHaveBeenCalledWith('welcome_email_failed', expect.anything());
  });

  it("'partly_sent', naming the refused address, and raises the alert with counts only", async () => {
    const m = load('placeholder-not-a-key');
    m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] });
    m.sgMail.send.mockImplementation(async (msg: { to: string }) => {
      if (msg.to === 'two@example.test') throw new Error('550 mailbox unavailable');
      return [{ statusCode: 202 }];
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
    expect(m.sgMail.send).not.toHaveBeenCalled();
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
    expect(m.sgMail.send).not.toHaveBeenCalled();
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
  const ready = () => { const m = load('placeholder-not-a-key'); m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] }); m.sgMail.send.mockResolvedValue([{ statusCode: 202 }]); return m; };

  it('does not mail an account with no Auth identity, names it, and raises account_cannot_sign_in', async () => {
    const m = ready();
    const noLogin = { userId: 'u3', email: 'three@example.test', name: 'Three', role: 'parent' };
    await expect(m.welcome.sendWelcomeEmails('school', [people[0], noLogin], 'Welcome'))
      .resolves.toEqual({ outcome: 'partly_sent', not_sent: ['three@example.test'] });
    expect(m.sgMail.send.mock.calls.map(([msg]) => msg.to)).toEqual(['one@example.test']);
    expect(m.logger.error).toHaveBeenCalledWith('welcome_email_no_login', expect.objectContaining({ not_sent: 1, of: 2 }));
    expect(m.logger.error).not.toHaveBeenCalledWith('welcome_email_failed', expect.anything());
  });

  it('does not mail an account whose Auth identity holds a different address', async () => {
    const m = ready();
    const mismatched = { userId: 'u9', email: 'four@example.test', name: 'Four', role: 'parent' };
    await expect(m.welcome.sendWelcomeEmails('school', [mismatched], 'Welcome'))
      .resolves.toEqual({ outcome: 'not_sent', not_sent: ['four@example.test'] });
    expect(m.sgMail.send).not.toHaveBeenCalled();
    expect(m.logger.error).toHaveBeenCalledWith('welcome_email_no_login', expect.objectContaining({ not_sent: 1, of: 1 }));
  });

  it('does not mail what it could not check, and says the check failed', async () => {
    const m = ready();
    m.auth.getUserById.mockRejectedValue(new Error('other side closed'));
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome'))
      .resolves.toEqual({ outcome: 'not_sent', not_sent: ['one@example.test', 'two@example.test'] });
    expect(m.sgMail.send).not.toHaveBeenCalled();
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
