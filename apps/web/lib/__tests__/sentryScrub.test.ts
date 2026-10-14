import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import * as Sentry from '@sentry/browser';
import { scrubEvent, scrubBreadcrumb, replayAllowed, stripUrl, stripIds, scrubEnvelope, scrubbingTransport } from '../sentryScrub';

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

/**
 * Record ids (SECURITY.md Round 43), against what a real Chrome sent: fixtures/sentryMeasuredEvents.json
 * holds a trace, an error, a replay event and a replay recording, captured unscrubbed from the installed
 * browser SDK on a page whose address, fetch, navigation, link and photo carried a school id and a student id.
 */
describe('record ids, on the shapes a real browser sent', () => {
  const measured = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sentryMeasuredEvents.json'), 'utf8'));
  const plants: string[] = measured.plants;
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const found = (v: unknown) => plants.filter((p) => JSON.stringify(v).includes(p));

  it('a uuid becomes [id] in any case, and nothing else changes', () => {
    expect(stripIds('/schools/A0A0A0A0-1111-4111-8111-5C0001000001/students')).toBe('/schools/[id]/students');
    expect(stripUrl('/a/b1b1b1b1-2222-4222-8222-0000000a0002/results?q=Ada#tab')).toBe('/a/[id]/results');
    expect(stripIds('/students/AD-001/12345')).toBe('/students/AD-001/12345');
  });

  it('the trace and the error carry the ids before scrubbing and none after, and still say where they were', () => {
    for (const name of ['transaction', 'error'] as const) {
      expect({ name, before: found(measured[name]) }).toEqual({ name, before: plants });
      const after = scrubEvent(copy(measured[name]));
      expect({ name, after: found(after) }).toEqual({ name, after: [] });
    }
    expect(scrubEvent(copy(measured.error)).request.url).toMatch(/\/schools\/\[id\]\/students\/\[id\]\/results$/);
  });

  it('the replay (its event and its whole recording, links included) carries none after the transport scrubs it', () => {
    const envelope: [object, Array<[{ type: string }, unknown]>] = [{}, [
      [{ type: 'replay_event' }, copy(measured.replay_event)],
      [{ type: 'replay_recording' }, measured.replay_recording],
    ]];
    expect(found(envelope)).toEqual(plants);
    const scrubbed = scrubEnvelope(copy(envelope));
    expect(scrubbed).not.toBeNull();
    expect(found(scrubbed)).toEqual([]);
    const recording = (scrubbed as typeof envelope)[1][1][1] as string;
    const events = JSON.parse(recording.slice(recording.indexOf('\n') + 1));
    // The control: the recording is all still there, its profile link pointing at [id], not emptied.
    expect(events).toHaveLength(JSON.parse(measured.replay_recording.slice(measured.replay_recording.indexOf('\n') + 1)).length);
    expect(recording).toContain('/registrar/students/[id]');
  });

  it('a recording it cannot read (compressed) is dropped, never sent unscrubbed', async () => {
    const compressed: [object, Array<[{ type: string }, unknown]>] = [{}, [[{ type: 'replay_recording' }, new Uint8Array([120, 156, 1, 2, 3])]]];
    expect(scrubEnvelope(compressed)).toBeNull();
    const sent: unknown[] = [];
    const transport = scrubbingTransport({ send: async (e: unknown) => { sent.push(e); return { statusCode: 200 }; }, flush: async () => true });
    await transport.send(compressed);
    await transport.send([{}, [[{ type: 'event' }, { message: 'ok' }]]]);
    expect(sent).toHaveLength(1);
  });
});
