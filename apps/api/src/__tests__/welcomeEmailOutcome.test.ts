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

type Mods = {
  sgMail: { send: jest.Mock };
  queue: { enqueueEmail: jest.Mock };
  pool: { query: jest.Mock };
  logger: { error: jest.Mock; warn: jest.Mock };
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
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
  });
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
    { email: 'one@example.test', name: 'One', role: 'parent' },
    { email: 'two@example.test', name: 'Two', role: 'parent' },
  ];

  it("'sent' only when SendGrid accepts every one", async () => {
    const m = load('placeholder-not-a-key');
    m.pool.query.mockResolvedValue({ rows: [{ name: 'Test School' }] });
    m.sgMail.send.mockResolvedValue([{ statusCode: 202 }]);
    await expect(m.welcome.sendWelcomeEmails('school', people, 'Welcome')).resolves.toEqual({ outcome: 'sent', not_sent: [] });
    expect(m.sgMail.send).toHaveBeenCalledTimes(2);
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
