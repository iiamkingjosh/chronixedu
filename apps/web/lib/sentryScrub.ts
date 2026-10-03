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
 */

type Bag = Record<string, unknown>;

/** An address without its query string or fragment. */
export function stripUrl(value: unknown): unknown {
  return typeof value === 'string' ? value.split(/[?#]/)[0] : value;
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

function scrubData(data: Bag | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (/(^|\.)(query|fragment|query_string)$/i.test(key) || /client_ip|client\.address/i.test(key)) delete data[key];
    else if (/(^|\.)(url|full|target|from|to|href)$/i.test(key)) data[key] = stripUrl(data[key]);
  }
}

export function scrubBreadcrumb<T extends { data?: Bag }>(crumb: T): T {
  scrubData(crumb.data);
  return crumb;
}

interface ScrubbableEvent {
  request?: { url?: string; method?: string };
  breadcrumbs?: Array<{ data?: Bag }>;
  spans?: Array<{ data?: Bag; description?: string }>;
  contexts?: { trace?: { data?: Bag } };
}

/** Cuts an event or a trace down to what is technical: method and path, nothing a person typed. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const { method, url } = event.request;
    // Rebuilt from method and path alone: headers, cookies, body and query string are dropped.
    (event as ScrubbableEvent).request = { method, url: stripUrl(url) as string | undefined };
  }
  for (const crumb of event.breadcrumbs ?? []) scrubData(crumb.data);
  scrubData(event.contexts?.trace?.data as Bag | undefined);
  for (const span of event.spans ?? []) {
    scrubData(span.data);
    if (span.description) span.description = stripUrl(span.description) as string;
  }
  return event;
}
