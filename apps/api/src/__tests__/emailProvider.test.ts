/**
 * The one place an email leaves the API (services/emailProvider.ts, 19 Oct 2026). Resend's SDK is replaced;
 * the provider's own code runs. What it must get right: Resend answers rather than throws, a spent quota is
 * its own kind and is held without asking Resend again, and every send is paced across the whole API.
 */
jest.mock('resend', () => {
  const send = jest.fn();
  return { Resend: jest.fn(() => ({ emails: { send } })), __send: send };
});
jest.mock('../config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

// A module, so its helpers do not share global scope with other test files that load by require.
export {};

type Provider = typeof import('../services/emailProvider');
type Loaded = { provider: Provider; send: jest.Mock; Resend: jest.Mock; logger: { error: jest.Mock } };

const ACCEPTED = { data: { id: 'email-id-1' }, error: null, headers: null };
const refused = (name: string, statusCode: number | null) => ({ data: null, error: { name, statusCode, message: name }, headers: null });
const EMAIL = { to: 'parent@example.test', subject: 'Subject', text: 'Body' };

/** Loads the provider afresh with these settings, as it reads them once when it loads. */
function load(env: { key?: string; from?: string; name?: string }): Loaded {
  const saved = { ...process.env };
  for (const [k, v] of [['RESEND_API_KEY', env.key], ['RESEND_FROM_EMAIL', env.from], ['RESEND_FROM_NAME', env.name]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let loaded!: Loaded;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    loaded = {
      provider: require('../services/emailProvider'),
      send: require('resend').__send,
      Resend: require('resend').Resend,
      logger: require('../config/logger').logger,
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
  });
  process.env = saved;
  return loaded;
}

const configured = () => load({ key: 'placeholder-not-a-key', from: 'no-reply@notify.example.test' });

afterEach(() => { jest.useRealTimers(); });

describe('what an answer from Resend means', () => {
  it('accepted only with an id, sent from "Name <address>", text and HTML both', async () => {
    const m = configured();
    m.send.mockResolvedValueOnce(ACCEPTED);
    await expect(m.provider.deliver({ ...EMAIL, html: '<p>Body</p>' })).resolves.toEqual({ accepted: true, id: 'email-id-1' });
    expect(m.send).toHaveBeenCalledWith({ from: 'Chronix Edu <no-reply@notify.example.test>', to: EMAIL.to, subject: 'Subject', text: 'Body', html: '<p>Body</p>' });
  });

  it('an error answer is a refusal, though nothing was thrown', async () => {
    const m = configured();
    m.send.mockResolvedValueOnce(refused('validation_error', 422));
    await expect(m.provider.deliver(EMAIL)).resolves.toEqual({ accepted: false, quota: false, error: 'validation_error (422): validation_error' });
  });

  it('an answer with no error and no id is a refusal', async () => {
    const m = configured();
    m.send.mockResolvedValueOnce({ data: {}, error: null, headers: null });
    await expect(m.provider.deliver(EMAIL)).resolves.toMatchObject({ accepted: false, quota: false });
  });

  it('a throw the SDK did not foresee is a refusal, never an exception', async () => {
    const m = configured();
    m.send.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(m.provider.deliver(EMAIL)).resolves.toEqual({ accepted: false, quota: false, error: 'exception: socket hang up' });
  });

  it('a burst refusal is not a quota refusal', async () => {
    const m = configured();
    m.send.mockResolvedValueOnce(refused('rate_limit_exceeded', 429));
    await expect(m.provider.deliver(EMAIL)).resolves.toMatchObject({ accepted: false, quota: false });
    expect(m.logger.error).not.toHaveBeenCalledWith('email_quota_exhausted', expect.anything());
  });

  it('without a key nothing is tried, and no client is made (the SDK throws without one)', async () => {
    const m = load({});
    expect(m.provider.isProviderConfigured()).toBe(false);
    await expect(m.provider.deliver(EMAIL)).resolves.toMatchObject({ accepted: false, quota: false });
    expect(m.Resend).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe('a spent quota', () => {
  it.each(['daily_quota_exceeded', 'monthly_quota_exceeded'])('%s holds every send for 15 minutes without asking Resend, then tries again', async (name) => {
    jest.useFakeTimers({ now: new Date('2026-10-19T10:00:00Z') });
    const m = configured();
    m.send.mockResolvedValueOnce(refused(name, 429)).mockResolvedValueOnce(ACCEPTED);

    await expect(m.provider.deliver(EMAIL)).resolves.toMatchObject({ accepted: false, quota: true });
    expect(m.logger.error).toHaveBeenCalledWith('email_quota_exhausted', expect.objectContaining({ held_minutes: 15 }));

    jest.setSystemTime(new Date('2026-10-19T10:14:59Z'));
    await expect(m.provider.deliver(EMAIL)).resolves.toMatchObject({ accepted: false, quota: true, error: expect.stringContaining('quota_held') });
    expect(m.send).toHaveBeenCalledTimes(1);

    // The control: after the hold, Resend is asked again, so the hold is not "refuse forever".
    jest.setSystemTime(new Date('2026-10-19T10:15:01Z'));
    await expect(m.provider.deliver(EMAIL)).resolves.toEqual({ accepted: true, id: 'email-id-1' });
    expect(m.send).toHaveBeenCalledTimes(2);
  });
});

describe('the pace', () => {
  it(`starts at most SENDS_PER_SECOND sends a second, in the order they were asked, however many callers ask at once`, async () => {
    jest.useFakeTimers({ now: 0 });
    const m = configured();
    const startedAt: number[] = [];
    m.send.mockImplementation(async () => { startedAt.push(Date.now()); return ACCEPTED; });

    const all = Promise.all([1, 2, 3, 4, 5, 6].map(n => m.provider.deliver({ ...EMAIL, to: `p${n}@example.test` })));
    await jest.advanceTimersByTimeAsync(2000);
    await all;

    const gap = 1000 / m.provider.SENDS_PER_SECOND;
    expect(startedAt).toEqual([0, gap, 2 * gap, 3 * gap, 4 * gap, 5 * gap]);
    expect(m.send.mock.calls.map(([msg]) => msg.to)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(p => `${p}@example.test`));
  });

  it('does not delay a send when the last one was long enough ago', async () => {
    jest.useFakeTimers({ now: 0 });
    const m = configured();
    const startedAt: number[] = [];
    m.send.mockImplementation(async () => { startedAt.push(Date.now()); return ACCEPTED; });
    await m.provider.deliver(EMAIL);
    jest.setSystemTime(5000);
    await m.provider.deliver(EMAIL);
    expect(startedAt).toEqual([0, 5000]);
  });
});
