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
    else data[key] = stripIds(data[key]);
  }
}

export function scrubBreadcrumb<T extends { data?: Bag; message?: string }>(crumb: T): T {
  scrubData(crumb.data);
  if (crumb.message) crumb.message = stripIds(crumb.message) as string;
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
    if (span.description) span.description = stripUrl(span.description) as string;
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

/** The replay event (one per replay, not passed to beforeSend): the addresses visited, the page it started on. */
export function scrubReplayEvent<T extends { urls?: unknown[]; request?: { url?: string }; transaction?: string }>(event: T): T {
  if (event.urls) event.urls = event.urls.map(stripUrl);
  if (event.request?.url) event.request.url = stripUrl(event.request.url) as string;
  if (event.transaction) event.transaction = stripIds(event.transaction) as string;
  return event;
}

/** Keys inside a replay recording whose value is an address. A performance span's description is one. */
const RECORDING_ADDRESS_KEY = /^(href|src|url|from|to|description)$/i;

function scrubDeep(value: unknown, key: string): unknown {
  if (typeof value === 'string') return RECORDING_ADDRESS_KEY.test(key) ? stripUrl(value) : stripIds(value);
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

type Envelope = [unknown, Array<[{ type?: string }, unknown]>];

/**
 * The replay's own scrubber, at the transport. The replay integration's beforeAddRecordingEvent sees only
 * breadcrumbs and performance spans (`maybeApplyCallback` checks `isCustomEvent`, @sentry/replay 10.58),
 * never the recorded page or its address, and the replay event skips beforeSend; the transport sees all
 * of it. An envelope holding a recording that cannot be scrubbed is not sent at all.
 */
export function scrubEnvelope<E>(envelope: E): E | null {
  const [, items] = envelope as unknown as Envelope;
  for (const item of items) {
    const [header] = item;
    if (header.type === 'replay_event') item[1] = scrubReplayEvent(item[1] as Parameters<typeof scrubReplayEvent>[0]);
    if (header.type === 'replay_recording') {
      const scrubbed = scrubRecordingPayload(item[1]);
      if (scrubbed === null) return null;
      item[1] = scrubbed;
    }
  }
  return envelope;
}

interface TransportLike<E, R> {
  send(envelope: E): PromiseLike<R>;
  flush(timeout?: number): PromiseLike<boolean>;
}

/** Wraps the SDK's transport so every envelope passes scrubEnvelope; one it drops resolves as sent. */
export function scrubbingTransport<E, R>(base: TransportLike<E, R>): TransportLike<E, R | Record<string, never>> {
  return {
    send: (envelope) => {
      const scrubbed = scrubEnvelope(envelope);
      return scrubbed === null ? Promise.resolve({}) : base.send(scrubbed);
    },
    flush: (timeout) => base.flush(timeout),
  };
}
