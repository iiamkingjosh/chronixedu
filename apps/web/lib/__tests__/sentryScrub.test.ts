import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import * as Sentry from '@sentry/browser';
import {
  scrubEvent, scrubBreadcrumb, replayAllowed, stripUrl, stripIds, stripLabels, scrubEnvelope, scrubbingTransport,
  scrubRecordingPayload, dropNotifier, isDropNotice, DROP_NOTICE, type Dropped,
} from '../sentryScrub';

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

/**
 * Round 44, against the second measurement in the same fixture: a button labelled with a name, clicked after
 * navigating to an address with both ids, then an error, then the page hidden so the SDK reported INP.
 */
describe('element labels, the INP span and the item types sent, on the shapes a real browser sent', () => {
  const measured = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sentryMeasuredEvents.json'), 'utf8'));
  const plants: string[] = measured.plants;
  const names: string[] = measured.names;
  const everything = [...plants, ...names];
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const found = (v: unknown, list: string[]) => list.filter((p) => JSON.stringify(v).includes(p));
  type Env = [Record<string, unknown>, Array<[{ type: string }, unknown]>];

  it('an element keeps its tag, id, classes, type and name, and loses the values of aria-label, title and alt', () => {
    expect(stripLabels('body > button#slow[aria-label="Edit Ada Obi"]')).toBe('body > button#slow[aria-label]');
    expect(stripLabels('div.row > select.w-full[aria-label="Decision for Ada Obi"][name="decision"]'))
      .toBe('div.row > select.w-full[aria-label][name="decision"]');
    expect(stripLabels('td[title="Ada Obi"] > img[alt="Ada Obi"]')).toBe('td[title] > img[alt]');
    // The SDK does not escape a value, so a quote inside one must not end it early.
    expect(stripLabels('a[title="Ada "the" Obi"][type="button"]')).toBe('a[title][type="button"]');
    // The control: what is the page's own stays.
    expect(stripLabels('form > input#first.w-full[type="text"][name="first_name"]')).toBe('form > input#first.w-full[type="text"][name="first_name"]');
  });

  it('the error after the click carries the ids and the name before scrubbing, none after, and still names the element', () => {
    expect(found(measured.click_error, everything)).toEqual(everything);
    const after = scrubEvent(copy(measured.click_error));
    expect(found(after, everything)).toEqual([]);
    const click = after.breadcrumbs.find((b: { category?: string }) => b.category === 'ui.click');
    expect(click.message).toBe('body > button#slow[aria-label]');
  });

  it('the INP span, its own envelope item, is cut at the transport and still says which page, which element and how long', () => {
    const envelope: Env = [{}, [[{ type: 'span' }, copy(measured.inp_span)]]];
    expect(found(envelope, everything)).toEqual([plants[0], plants[1], ...names]);
    const scrubbed = scrubEnvelope(copy(envelope)) as Env;
    expect(found(scrubbed, everything)).toEqual([]);
    const span = scrubbed[1][0][1] as { data: Record<string, unknown>; description: string; measurements: unknown };
    expect(span.data.transaction).toBe('/schools/[id]/students/[id]/results');
    expect(span.description).toBe('body > button#slow[aria-label]');
    expect(span.measurements).toEqual(measured.inp_span.measurements);
  });

  it('the replay segment holding the slow click carries none after the transport scrubs it, and the click is still there', () => {
    const envelope: Env = [{}, [
      [{ type: 'replay_event' }, copy(measured.click_replay_event)],
      [{ type: 'replay_recording' }, measured.click_replay_recording],
    ]];
    expect(found(envelope, everything)).toEqual(everything);
    const scrubbed = scrubEnvelope(copy(envelope)) as Env;
    expect(found(scrubbed, everything)).toEqual([]);
    expect(scrubbed[1][1][1]).toContain('"message":"body > button#slow[aria-label]"');
  });

  it('sends only the item types it names: another is removed and reported, and an envelope left empty is not sent', () => {
    const dropped: Dropped[] = [];
    const mixed: Env = [{}, [[{ type: 'statsd' }, 'probe:1|c'], [{ type: 'event' }, { message: 'ok' }], [{ type: 'constructor' }, {}]]];
    const out = scrubEnvelope(mixed, (d) => dropped.push(d)) as Env;
    expect(out[1].map(([header]) => header.type)).toEqual(['event']);
    expect(dropped).toEqual([
      { reason: 'item_type_not_allowed', itemType: 'statsd' },
      { reason: 'item_type_not_allowed', itemType: 'constructor' },
    ]);
    expect(scrubEnvelope([{}, [[{ type: 'profile' }, {}]]])).toBeNull();
    // The control: every type it names is sent (the recording is tested above, as it must be a readable string).
    for (const type of ['event', 'transaction', 'span', 'replay_event', 'session', 'client_report']) {
      expect({ type, sent: scrubEnvelope([{}, [[{ type }, {}]]]) !== null }).toEqual({ type, sent: true });
    }
  });

  it('the transport alone is enough: an error and a trace that reach it unscrubbed leave it carrying nothing', () => {
    const envelope: Env = [{}, [
      [{ type: 'event' }, copy(measured.click_error)],
      [{ type: 'transaction' }, copy(measured.transaction)],
    ]];
    expect(found(envelope, everything)).toEqual(everything);
    const scrubbed = scrubEnvelope(copy(envelope)) as Env;
    expect(found(scrubbed, everything)).toEqual([]);
    // The control: both are still sent, and still say where they were.
    expect(scrubbed[1].map(([header]) => header.type)).toEqual(['event', 'transaction']);
    expect((scrubbed[1][0][1] as { request: { url: string } }).request.url).toMatch(/\/schools\/\[id\]\/students\/\[id\]\/results$/);
  });

  it('an envelope header naming the page loses its ids', () => {
    const out = scrubEnvelope([{ trace: { transaction: `/schools/${plants[0]}/students` } }, [[{ type: 'event' }, {}]]]) as Env;
    expect(out[0]).toEqual({ trace: { transaction: '/schools/[id]/students' } });
  });

  it('a recording that is a string but not JSON, or has no segment header, is dropped and reported', async () => {
    expect(scrubRecordingPayload('{"segment_id":0}\nnot json')).toBeNull();
    expect(scrubRecordingPayload('{"segment_id":0}')).toBeNull();
    // The control: the same shape, readable, is kept.
    expect(scrubRecordingPayload('{"segment_id":0}\n[]')).toBe('{"segment_id":0}\n[]');
    const dropped: Dropped[] = [];
    const sent: unknown[] = [];
    const transport = scrubbingTransport({ send: async (e: unknown) => { sent.push(e); return {}; }, flush: async () => true }, (d) => dropped.push(d));
    await transport.send([{}, [[{ type: 'replay_event' }, {}], [{ type: 'replay_recording' }, '{"segment_id":0}\nnot json']]]);
    expect(sent).toEqual([]);
    expect(dropped).toEqual([{ reason: 'replay_unreadable', itemType: 'replay_recording' }]);
  });

  it('a drop is told once per page load for each reason and item type, and the notice is recognisable', () => {
    const told: unknown[] = [];
    const note = dropNotifier((message, tags) => told.push([message, tags]));
    note({ reason: 'replay_unreadable', itemType: 'replay_recording' });
    note({ reason: 'replay_unreadable', itemType: 'replay_recording' });
    note({ reason: 'item_type_not_allowed', itemType: 'statsd' });
    expect(told).toEqual([
      [DROP_NOTICE, { reason: 'replay_unreadable', item_type: 'replay_recording' }],
      [DROP_NOTICE, { reason: 'item_type_not_allowed', item_type: 'statsd' }],
    ]);
    expect(isDropNotice({ message: DROP_NOTICE })).toBe(true);
    expect(isDropNotice({ message: 'measured error' })).toBe(false);
  });
});
