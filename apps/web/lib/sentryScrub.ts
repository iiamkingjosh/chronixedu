/**
 * What the web app's Sentry may send (3 Oct 2026, SECURITY.md Round 34). Sentry is a sub-processor
 * for technical data only (CLAUDE.md, Conventions), so an address keeps its path and loses its query
 * string and fragment, and session replay never runs where a page holds a credential.
 *
 * Measured with the browser SDK this app uses: a fetch breadcrumb carried the full API address, so a
 * search term in a query string (a student's name) went with every error. Not measured (rrweb cannot
 * run without a DOM), reasoned from how it works: a replay records the page's full address when it
 * starts, and the password-reset page arrives with `#access_token=…` until its own code clears it.
 *
 * Pure, so every rule is testable (lib/__tests__/sentryScrub.test.ts). instrumentation-client.ts,
 * sentry.server.config.ts and sentry.edge.config.ts all use it.
 *
 * Record ids leave too (SECURITY.md Round 43): an address like /schools/<uuid>/students/<uuid>/results
 * names a school and a child. Measured 14 Oct 2026 with the installed browser SDK in a real Chrome
 * (Puppeteer) against a local ingest: the ids rode in the page path (`transaction`, `request.url`),
 * breadcrumbs, span descriptions and data (`browser.script.invoker`, `code.filepath`), stack-frame file
 * names, the replay event's `urls`, and the replay recording: its page address, its breadcrumbs and
 * performance spans, and the `href` of every link in the recorded page, which text masking does not cover.
 *
 * Two more, measured the same way the same day (SECURITY.md Round 44). The INP report (how long the page took
 * to answer a click) is a span sent as its own envelope item, so it skips beforeSendTransaction, and its
 * `transaction` is the page's address. And the SDK names a clicked element with its `aria-label`, `title` and
 * `alt` (`button#save[aria-label="Decision for Ada Obi"]`), which this app fills with a pupil's name: in the
 * click breadcrumb of every error, the replay's breadcrumbs, and the INP span. The replay's own copy of the
 * page masks those attributes; the SDK's description of the element does not.
 */

type Bag = Record<string, unknown>;

/** A canonical uuid, the way every record (school, student, invoice) is named in an address. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const ID_PLACEHOLDER = '[id]';

/** Every uuid in a string replaced by `[id]`. */
export function stripIds(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(UUID, ID_PLACEHOLDER) : value;
}

/** An address without its query string or fragment, and without record ids. */
export function stripUrl(value: unknown): unknown {
  return typeof value === 'string' ? (stripIds(value.split(/[?#]/)[0]) as string) : value;
}

/**
 * An element as the SDK describes it (core's htmlTreeAsString: `tag#id.class[aria-label="…"][type="…"]`,
 * ancestors joined by ` > `) keeps the names of aria-label, title and alt and loses their values, which a page
 * writes for people to read. The SDK does not escape a value, so its end is found by what follows: another
 * attribute, a space or the end. id, class, type and name are the page's own and stay.
 */
const LABEL_VALUE = /\[(aria-label|title|alt)="[\s\S]*?"\](?=\[|\s|$)/g;

export function stripLabels(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(LABEL_VALUE, '[$1]') : value;
}

/** Free text (a breadcrumb's message, a value that is not an address): no record ids, no element labels. */
export function stripText(value: unknown): unknown {
  return stripLabels(stripIds(value));
}

/**
 * Pages where replay never runs: the sign-in pages (a password is typed, a reset token arrives in the
 * address) and the whole platform-admin area, which shows every school's data and, on its security
 * page, an authenticator QR code: a drawn image that no text masking covers.
 */
export const REPLAY_EXCLUDED_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/super-admin'];

export function replayAllowed(pathname: string): boolean {
  return !REPLAY_EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Keys whose value is an address: it loses its query string and fragment as well as its ids. */
const ADDRESS_KEY = /(^|\.)(url|full|target|from|to|href|src|invoker|filepath)$/i;

function scrubData(data: Bag | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (/(^|\.)(query|fragment|query_string)$/i.test(key) || /client_ip|client\.address/i.test(key)) delete data[key];
    else if (ADDRESS_KEY.test(key)) data[key] = stripUrl(data[key]);
    else data[key] = stripText(data[key]);
  }
}

export function scrubBreadcrumb<T extends { data?: Bag; message?: string }>(crumb: T): T {
  scrubData(crumb.data);
  // A click or input breadcrumb's message is the element's description.
  if (crumb.message) crumb.message = stripText(crumb.message) as string;
  return crumb;
}

interface ScrubbableEvent {
  request?: { url?: string; method?: string };
  transaction?: string;
  breadcrumbs?: Array<{ data?: Bag; message?: string }>;
  spans?: Array<{ data?: Bag; description?: string }>;
  contexts?: { trace?: { data?: Bag } };
  exception?: { values?: Array<{ stacktrace?: { frames?: Array<{ filename?: string; abs_path?: string }> } }> };
}

/** Cuts an event or a trace down to what is technical: method and path, nothing a person typed. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const { method, url } = event.request;
    // Rebuilt from method and path alone: headers, cookies, body and query string are dropped.
    (event as ScrubbableEvent).request = { method, url: stripUrl(url) as string | undefined };
  }
  if (event.transaction) event.transaction = stripIds(event.transaction) as string;
  for (const crumb of event.breadcrumbs ?? []) scrubBreadcrumb(crumb);
  scrubData(event.contexts?.trace?.data as Bag | undefined);
  for (const span of event.spans ?? []) {
    scrubData(span.data);
    if (span.description) span.description = stripLabels(stripUrl(span.description)) as string;
  }
  // The page's own scripts are named by its address, query string included.
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = stripUrl(frame.filename) as string;
      if (frame.abs_path) frame.abs_path = stripUrl(frame.abs_path) as string;
    }
  }
  return event;
}

type ReplayEventShape = { urls?: unknown[]; request?: { url?: string }; transaction?: string };

/** The replay event (one per replay, not passed to beforeSend): the addresses visited, the page it started on. */
export function scrubReplayEvent<T extends ReplayEventShape>(event: T): T {
  if (event.urls) event.urls = event.urls.map(stripUrl);
  if (event.request?.url) event.request.url = stripUrl(event.request.url) as string;
  if (event.transaction) event.transaction = stripIds(event.transaction) as string;
  return event;
}

/**
 * A span sent as its own envelope item, never through beforeSendTransaction: in this SDK, the INP report. Its
 * `transaction` attribute is the page's address and its description names the element clicked.
 */
export function scrubSpan<T extends { data?: Bag; description?: string }>(span: T): T {
  scrubData(span.data);
  if (span.description) span.description = stripText(span.description) as string;
  return span;
}

/** Keys inside a replay recording whose value is an address. A performance span's description is one. */
const RECORDING_ADDRESS_KEY = /^(href|src|url|from|to|description)$/i;

function scrubDeep(value: unknown, key: string): unknown {
  if (typeof value === 'string') return RECORDING_ADDRESS_KEY.test(key) ? stripUrl(value) : stripText(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, key));
  if (value && typeof value === 'object') {
    const out: Bag = {};
    for (const [k, v] of Object.entries(value as Bag)) out[k] = scrubDeep(v, k);
    return out;
  }
  return value;
}

/**
 * A replay recording as the SDK hands it to the transport with compression off: its segment header, a
 * newline, then the recording's events as JSON. Walked whole: the recorded page keeps link addresses
 * (`href`) and its meta event the page's address, which carry record ids; masking covers text and inputs,
 * not attributes. Returns null when it cannot be read, so the caller drops it rather than send it unscrubbed.
 */
export function scrubRecordingPayload(payload: unknown): string | null {
  if (typeof payload !== 'string') return null;
  const cut = payload.indexOf('\n');
  if (cut === -1) return null;
  try {
    const events: unknown = JSON.parse(payload.slice(cut + 1));
    return `${payload.slice(0, cut)}\n${JSON.stringify(scrubDeep(events, ''))}`;
  } catch {
    return null; // silent-ok: not JSON means compressed or malformed; the caller drops the whole replay
  }
}

type Envelope = [{ trace?: { transaction?: unknown } } | undefined, Array<[{ type?: string } | undefined, unknown]>];

/**
 * Every item type the transport sends, and how it is cut (SECURITY.md Round 44). Errors and traces were cut by
 * beforeSend and beforeSendTransaction and are cut again here, so the transport alone is enough; the replay and
 * a span sent on its own skip both hooks and are cut only here. A session (`did` is the user's id, which Sentry
 * may have: CLAUDE.md, Conventions) and a client report (counts of what the SDK discarded) carry no address. Any
 * other type is removed: the SDK can send attachments, feedback, profiles, logs and metrics, none of which this
 * app turns on, so a type here that nobody has looked at is not sent on trust. A Map, so that an item named
 * `constructor` finds nothing.
 */
const SENT_ITEMS = new Map<string, (payload: unknown) => unknown>([
  ['event', (p) => scrubEvent(p as ScrubbableEvent)],
  ['transaction', (p) => scrubEvent(p as ScrubbableEvent)],
  ['span', (p) => scrubSpan(p as { data?: Bag; description?: string })],
  ['replay_event', (p) => scrubReplayEvent(p as ReplayEventShape)],
  ['replay_recording', scrubRecordingPayload],
  ['session', (p) => p],
  ['client_report', (p) => p],
]);

export type DropReason = 'item_type_not_allowed' | 'replay_unreadable';
export interface Dropped { reason: DropReason; itemType: string }

/**
 * The scrubber at the transport, the one place that sees every envelope. The replay integration's
 * beforeAddRecordingEvent sees only breadcrumbs and performance spans (`maybeApplyCallback` checks
 * `isCustomEvent`, @sentry/replay 10.58), never the recorded page or its address, and the replay event and the
 * INP span skip beforeSend. An item of a type not in SENT_ITEMS is removed; an envelope holding a recording that
 * cannot be scrubbed is not sent at all, nor one left empty. Each removal is reported to `onDrop`.
 */
export function scrubEnvelope<E>(envelope: E, onDrop?: (dropped: Dropped) => void): E | null {
  const env = envelope as unknown as Envelope;
  // The trace context names the page only when its name is not an address; measured absent, cut anyway.
  const trace = env[0]?.trace;
  if (trace?.transaction) trace.transaction = stripIds(trace.transaction);
  const kept: Envelope[1] = [];
  for (const item of env[1]) {
    const itemType = String(item[0]?.type);
    const scrub = SENT_ITEMS.get(itemType);
    if (!scrub) {
      onDrop?.({ reason: 'item_type_not_allowed', itemType: itemType.slice(0, 40) });
      continue;
    }
    const scrubbed = scrub(item[1]);
    if (scrubbed === null) {
      onDrop?.({ reason: 'replay_unreadable', itemType });
      return null;
    }
    item[1] = scrubbed;
    kept.push(item);
  }
  if (kept.length === 0) return null;
  env[1] = kept;
  return envelope;
}

interface TransportLike<E, R> {
  send(envelope: E): PromiseLike<R>;
  flush(timeout?: number): PromiseLike<boolean>;
}

/** Wraps the SDK's transport so every envelope passes scrubEnvelope; one it drops resolves as sent. */
export function scrubbingTransport<E, R>(
  base: TransportLike<E, R>,
  onDrop?: (dropped: Dropped) => void,
): TransportLike<E, R | Record<string, never>> {
  return {
    send: (envelope) => {
      const scrubbed = scrubEnvelope(envelope, onDrop);
      return scrubbed === null ? Promise.resolve({}) : base.send(scrubbed);
    },
    flush: (timeout) => base.flush(timeout),
  };
}

/** The message Sentry receives when the transport keeps something back. It carries the reason and the item type, nothing else. */
export const DROP_NOTICE = 'sentry_item_not_sent';

/**
 * Turns a removal into one notice per page load for each reason and item type, so a replay that never arrives
 * is seen in Sentry rather than missed in silence, without a notice for every replay segment.
 */
export function dropNotifier(capture: (message: string, tags: Record<string, string>) => void): (dropped: Dropped) => void {
  const told = new Set<string>();
  return ({ reason, itemType }) => {
    const key = `${reason}:${itemType}`;
    if (told.has(key)) return;
    told.add(key);
    capture(DROP_NOTICE, { reason, item_type: itemType });
  };
}

/**
 * A notice must never start a replay of its own. The replay sends itself only for an event with an exception
 * (`shouldSampleForBufferEvent`, @sentry/replay 10.58), and the notice is a message, which has none while
 * `attachStacktrace` is off, as it is here. With it on, a message carries its stack as an exception, and the
 * notice alone sent a replay (measured 14 Oct 2026). So the replay's beforeErrorSampling asks this first.
 */
export function isDropNotice(event: { message?: unknown }): boolean {
  return event.message === DROP_NOTICE;
}
