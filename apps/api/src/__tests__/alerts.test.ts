import fs from 'fs';
import path from 'path';
import * as Sentry from '@sentry/node';
import { logger } from '../config/logger';
import { ALERTS, NOT_ALERTED, THROTTLE_MS, alertFromLog, resetAlertThrottle } from '../config/alerts';

// What reaches Sentry is what this records: the scope calls and the captured message.
const scopeCalls: Array<[string, unknown[]]> = [];
const fakeScope = new Proxy({}, {
  get: (_t, prop: string) => (...args: unknown[]) => { scopeCalls.push([prop, args]); },
});
jest.mock('@sentry/node', () => ({
  withScope: jest.fn((cb: (scope: unknown) => void) => cb(fakeScope)),
  captureMessage: jest.fn(),
}));
const captureMessage = Sentry.captureMessage as jest.Mock;

/** Everything one test sent to Sentry, as text: the messages plus every scope call. */
const sentToSentry = () => JSON.stringify({ messages: captureMessage.mock.calls, scope: scopeCalls });
const scopeArg = (method: string) => scopeCalls.filter(([m]) => m === method).map(([, args]) => args[0]);

beforeEach(() => {
  jest.clearAllMocks();
  scopeCalls.length = 0;
  resetAlertThrottle();
  jest.spyOn(console, 'log').mockImplementation(() => undefined); // the Console transport
});
afterEach(() => jest.restoreAllMocks());

describe('the logger sends listed conditions to Sentry, and only those', () => {
  it('a listed event logged through the real logger reaches Sentry (the control)', () => {
    logger.error('redis_client_error', { error: 'connect ECONNREFUSED 10.0.0.5:6379' });

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][0]).toMatch(/^redis_unavailable: Redis is unreachable/);
    expect(scopeArg('setFingerprint')).toEqual([['alert', 'redis_unavailable', 'test']]); // NODE_ENV under jest
    expect(scopeArg('setLevel')).toEqual(['error']);
    expect(scopeArg('setContext')).toEqual(['alert']);
  });

  it('an unlisted error event does not, whatever its level', () => {
    logger.error('students_bulk_import_results_file_failed', { error: 'disk full' });
    logger.error('some_event_nobody_listed', { error: 'x' });
    logger.warn('sms_disabled', { run: 'startup' });

    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('every bestEffort() Redis failure raises the same Redis alert', () => {
    for (const event of ['login_lockout_unavailable', 'ctx_cache_unavailable', 'rate_limit_store_unavailable']) {
      resetAlertThrottle();
      logger.error(event, { error: 'Command timed out' });
    }
    expect(captureMessage).toHaveBeenCalledTimes(3);
    expect(scopeArg('setFingerprint')).toEqual(Array(3).fill(['alert', 'redis_unavailable', 'test']));
  });
});

describe('one outage is one alert', () => {
  it('sends once per window, then says how many it held back', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) alertFromLog({ message: 'redis_client_error', error: 'ECONNREFUSED' }, t0 + i * 2000);
    expect(captureMessage).toHaveBeenCalledTimes(1);

    alertFromLog({ message: 'redis_client_error', error: 'ECONNREFUSED' }, t0 + THROTTLE_MS);
    expect(captureMessage).toHaveBeenCalledTimes(2);
    const contexts = scopeCalls.filter(([m]) => m === 'setContext').map(([, args]) => args[1] as Record<string, unknown>);
    expect(contexts[1]).toMatchObject({ log_event: 'redis_client_error', held_back_since_last: 49 });
  });

  it('throttles each condition separately', () => {
    alertFromLog({ message: 'redis_client_error', error: 'a' }, 0);
    alertFromLog({ message: 'sendgrid_email_failed', error: 'b' }, 1);
    expect(captureMessage).toHaveBeenCalledTimes(2);
  });
});

describe('Sentry gets technical data only', () => {
  it('drops the address and subject a mail failure logs, keeping the error', () => {
    logger.error('sendgrid_email_failed', { to: 'ada.parent@example.com', subject: 'Fee reminder for Ada Obi', error: 'Unauthorized' });

    expect(captureMessage).toHaveBeenCalledTimes(1); // it was sent: the absences below are not from silence
    const sent = sentToSentry();
    expect(sent).toContain('Unauthorized');
    expect(sent).not.toContain('ada.parent@example.com');
    expect(sent).not.toContain('Ada Obi');
  });

  it('reduces an error object to its message', () => {
    logger.error('staff_bulk_import_summary_audit_log_failed', { schoolId: 'school-1', err: new Error('deadlock detected') });

    const context = scopeCalls.find(([m]) => m === 'setContext')![1][1] as Record<string, unknown>;
    expect(context.err).toBe('deadlock detected');
    expect(context).not.toHaveProperty('schoolId');
  });
});

describe('the list is complete and current (ratchet)', () => {
  const SRC = path.join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!/^__(db_)?tests__$/.test(entry.name)) walk(full); }
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(SRC);
  const code = files.filter(f => !f.endsWith(path.join('config', 'alerts.ts'))).map(f => fs.readFileSync(f, 'utf8')).join('\n');

  const errorEvents = new Set([...code.matchAll(/logger\.error\(\s*'([A-Za-z0-9_]+)'/g)].map(m => m[1]));
  const bestEffortEvents = new Set([...code.matchAll(/bestEffort\(\s*'([A-Za-z0-9_]+)'/g)].map(m => m[1]));
  const alerted = new Set<string>(Object.values(ALERTS).flatMap(spec => [...spec.events]));

  it('scans the real code (the control: it finds the events it must)', () => {
    expect(errorEvents.size).toBeGreaterThan(40);
    expect(errorEvents).toContain('redis_client_error');
    expect(bestEffortEvents).toContain('login_lockout_unavailable');
  });

  it('every logger.error event is either an alert or not alerted, with a reason', () => {
    const unclassified = [...errorEvents].filter(e => !alerted.has(e) && !(e in NOT_ALERTED));
    expect(unclassified).toEqual([]);
  });

  it('every bestEffort() event raises the Redis alert', () => {
    const redisEvents: readonly string[] = ALERTS.redis_unavailable.events;
    expect([...bestEffortEvents].filter(e => !redisEvents.includes(e))).toEqual([]);
  });

  it('no event is both alerted and excused', () => {
    expect([...alerted].filter(e => e in NOT_ALERTED)).toEqual([]);
  });

  it('every listed event still exists in the code, so a rename cannot silence an alert', () => {
    const listed = [...alerted, ...Object.keys(NOT_ALERTED)];
    expect(listed.filter(e => !code.includes(`'${e}'`))).toEqual([]);
  });

  /**
   * Item G (1 Oct 2026): a failure the code catches and drops, without a log line, is invisible to
   * every list above. Seven were found that way, one of them an audit write. A handler that ignores
   * the error (`.catch(() => {})`, `=> undefined`, `=> null`) or an empty `catch {}` must carry
   * `// silent-ok: <reason>` on its lines. Comments are stripped first, so prose about the pattern
   * is not a hit.
   */
  function silentCatches(source: string): Array<{ line: number; marked: boolean }> {
    // CRLF too: most of src is CRLF, and a trailing \r stopped the comment strip from matching.
    const lines = source.split(/\r?\n/);
    const stripped = lines.map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
    const found: Array<{ line: number; marked: boolean }> = [];
    for (const re of [/\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/g, /catch\s*(\([^)]*\))?\s*\{\s*\}/g]) {
      for (const m of stripped.matchAll(re)) {
        const start = stripped.slice(0, m.index).split('\n').length;
        const end = start + m[0].split('\n').length - 1;
        found.push({ line: start, marked: /silent-ok: \S/.test(lines.slice(start - 1, end).join('\n')) });
      }
    }
    return found;
  }

  it('the silent-catch scanner finds what it must (the control)', () => {
    const sample = [
      'p.catch(() => {});',
      'q.catch(() => undefined); // silent-ok: rethrown below',
      'try { a(); } catch {',
      '  // nothing',
      '}',
      '// p.catch(() => {}) in a comment is prose, not code',
    ].join('\n');
    const expected = [
      { line: 1, marked: false },
      { line: 2, marked: true },
      { line: 3, marked: false },
    ];
    expect(silentCatches(sample)).toEqual(expected);
    expect(silentCatches(sample.replace(/\n/g, '\r\n'))).toEqual(expected); // most of src is CRLF
  });

  it('no error is caught and dropped without a stated reason (item G)', () => {
    const unmarked = files.flatMap(f => silentCatches(fs.readFileSync(f, 'utf8'))
      .filter(c => !c.marked)
      .map(c => `${path.relative(SRC, f)}:${c.line}`));
    expect(unmarked).toEqual([]);
  });

  it('logger.error is never called with a computed event name, except inside bestEffort', () => {
    const dynamic = files
      .filter(f => !f.endsWith(path.join('config', 'alerts.ts')))
      .flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/logger\.error\(\s*([^'\s])/g)].map(() => path.basename(f)));
    expect(dynamic).toEqual(['rateLimit.ts']);
  });
});
