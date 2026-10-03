import http from 'http';
import type { AddressInfo } from 'net';
import * as Sentry from '@sentry/browser';
import { scrubEvent, scrubBreadcrumb, replayAllowed, stripUrl } from '../sentryScrub';

/**
 * The web app's Sentry gets technical data only (SECURITY.md Round 34). The second block runs the
 * browser SDK this app ships (@sentry/browser, inside @sentry/nextjs), with these rules, against a
 * fake ingest on 127.0.0.1, and searches everything it receives. The SDK's own fetch
 * instrumentation makes the breadcrumb, so the test measures what the SDK records, not a shape
 * written here. Without the rules, the planted search term arrived (measured 3 Oct 2026).
 */

describe('the rules', () => {
  it('an address keeps its path and loses its query string and fragment', () => {
    expect(stripUrl('https://api.example/api/schools/1/students?search=Ada#top')).toBe('https://api.example/api/schools/1/students');
    expect(stripUrl('/reset-password#access_token=abc&type=recovery')).toBe('/reset-password');
    expect(stripUrl('/plain')).toBe('/plain');
    expect(stripUrl(42)).toBe(42);
  });

  it('replay never runs on the sign-in pages or anywhere for platform admins, and does elsewhere', () => {
    for (const p of ['/login', '/forgot-password', '/reset-password', '/super-admin', '/super-admin/security', '/super-admin/schools/1']) {
      expect({ p, allowed: replayAllowed(p) }).toEqual({ p, allowed: false });
    }
    // The control: replay is not simply off everywhere.
    for (const p of ['/dashboard', '/settings/export', '/loginhelp', '/super-administrators']) {
      expect({ p, allowed: replayAllowed(p) }).toEqual({ p, allowed: true });
    }
  });

  it('a trace loses query strings and client addresses from its attributes and spans', () => {
    const trace = scrubEvent({
      request: { url: 'https://edu.example/parent/fees?payment=success#x', method: 'GET', headers: { a: 'b' } },
      contexts: { trace: { data: { 'http.query': '?q=1', 'url.full': 'https://x/y?q=1', 'http.client_ip': '203.0.113.9', 'http.method': 'GET' } } },
      spans: [{ description: 'GET https://api.example/a?search=Ada', data: { 'http.url': 'https://api.example/a?search=Ada', 'url.query': 'search=Ada' } }],
    });
    expect(trace.request).toEqual({ method: 'GET', url: 'https://edu.example/parent/fees' });
    expect(trace.contexts?.trace?.data).toEqual({ 'url.full': 'https://x/y', 'http.method': 'GET' });
    expect(trace.spans?.[0]).toEqual({ description: 'GET https://api.example/a', data: { 'http.url': 'https://api.example/a' } });
    expect(scrubBreadcrumb({ data: { from: '/login', to: '/reset-password#access_token=t' } }).data).toEqual({ from: '/login', to: '/reset-password' });
  });
});

describe('what the browser SDK sends with these rules', () => {
  const PLANTED = { search: 'PLANTED-SEARCH-TERM', token: 'PLANTED-RESET-TOKEN', query: 'PLANTED-PAGE-QUERY', header: 'PLANTED-HEADER' };
  const received: string[] = [];
  let ingest: http.Server;
  let api: http.Server;

  beforeAll(async () => {
    ingest = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => { received.push(Buffer.concat(chunks).toString('utf8')); res.writeHead(200); res.end('{}'); });
    });
    api = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise<void>((r) => ingest.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));

    Sentry.init({
      dsn: `http://public@127.0.0.1:${(ingest.address() as AddressInfo).port}/1`,
      tracesSampleRate: 0,
      beforeSend: (event) => scrubEvent(event),
      beforeSendTransaction: (event) => scrubEvent(event),
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    });

    // A real fetch, so the SDK's own instrumentation writes the breadcrumb.
    await fetch(`http://127.0.0.1:${(api.address() as AddressInfo).port}/api/schools/x/students?search=${PLANTED.search}`);
    // The reset page as it arrives: the token in the fragment, before the page's code clears it.
    Sentry.addBreadcrumb({ category: 'navigation', data: { from: '/login', to: `/reset-password#access_token=${PLANTED.token}` } });
    Sentry.captureEvent({
      message: 'probe-web-event',
      request: { url: `https://edu.example/reset-password?next=${PLANTED.query}#access_token=${PLANTED.token}`, headers: { 'x-probe': PLANTED.header } },
    });
    Sentry.captureException(new Error('probe-web-error'));
    await Sentry.flush(5000);
  });

  afterAll(async () => {
    await Sentry.close(2000);
    await new Promise((r) => api.close(r));
    await new Promise((r) => ingest.close(r));
  });

  it('delivers the events, with the fetch breadcrumb and the paths (the control: a silent Sentry would pass the next test)', () => {
    const all = received.join('\n');
    expect(all).toContain('probe-web-error');
    expect(all).toContain('probe-web-event');
    expect(all).toContain('/api/schools/x/students');
    expect(all).toContain('/reset-password');
  });

  it('carries none of the planted values', () => {
    const all = received.join('\n');
    for (const [where, value] of Object.entries(PLANTED)) {
      expect({ where, sent: all.includes(value) }).toEqual({ where, sent: false });
    }
  });
});
