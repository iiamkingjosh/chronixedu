import * as Sentry from '@sentry/node';
import type { Event, NodeOptions } from '@sentry/node';

/**
 * What a request may tell Sentry: its method and its path. Nothing else (3 Oct 2026, SECURITY.md
 * Round 33).
 *
 * The SDK's defaults record the incoming request's body (up to 10 KB), headers, cookies and query
 * string, and attach them to every error event AND every sampled trace. Measured against these
 * options without the scrub: a traced POST /api/auth/login sent the typed password and email, and
 * every request sent its `Authorization` bearer token, `x-support-session-id` and
 * `x-health-token`. Production samples 20% of requests, so one login in five sent its password to
 * Sentry. The DPA names Sentry a sub-processor for technical data only (CLAUDE.md, Conventions).
 *
 * Two layers, because each covers a path the other might not: the body is never read
 * (maxIncomingRequestBodySize 'none'), and whatever request data an event carries anyway is cut
 * down to method and path before it is sent, for errors and traces alike.
 *
 * Query strings and client addresses are cut too. Query strings can carry a search term (a
 * student's name) or a Paystack reference, and outgoing calls carry Supabase filter values; they
 * travel in the trace's own attributes, its spans and its breadcrumbs, not only in `request`
 * (measured: `http.query`, `http.url`, `http.target`, and `http.client_ip` from X-Forwarded-For).
 */
const path = (value: unknown) => (typeof value === 'string' ? value.split('?')[0] : value);

function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (/query|client_ip|client\.address/i.test(key)) delete data[key];
    else if (/url|target/i.test(key)) data[key] = path(data[key]);
  }
}

export function scrubRequest<T extends Event>(event: T): T {
  if (event.request) {
    const { method, url } = event.request;
    event.request = { method, url: path(url) as string | undefined };
  }
  scrubData(event.contexts?.trace?.data as Record<string, unknown> | undefined);
  for (const span of event.spans ?? []) {
    scrubData(span.data as Record<string, unknown> | undefined);
    if (span.description) span.description = path(span.description) as string;
  }
  for (const crumb of event.breadcrumbs ?? []) {
    scrubData(crumb.data);
    if (crumb.message) crumb.message = path(crumb.message) as string;
  }
  return event;
}

export function sentryOptions(dsn: string): NodeOptions {
  return {
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    sendDefaultPii: false,
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
    beforeSend: (event) => scrubRequest(event),
    beforeSendTransaction: (event) => scrubRequest(event),
  };
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init(sentryOptions(dsn));
}

export { Sentry };
