import * as Sentry from '@sentry/nextjs';
import { scrubEvent, scrubBreadcrumb, replayAllowed, scrubbingTransport } from '@/lib/sentryScrub';

// The browser half of Sentry. Formerly sentry.client.config.ts. @sentry/nextjs v10 injects this
// file into the client bundle on webpack builds (Next 14); Next 15.3+ loads it natively, and the
// old name does not work under Turbopack.

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  // A replay is sent only when an error happens, never for a session in which nothing went wrong
  // (SECURITY.md Round 43). The DPA lists Sentry for error monitoring, "technical/diagnostic data only";
  // recording ordinary sessions is not error monitoring, and no legal page discloses it.
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
  // Addresses keep their path and lose query string, fragment and record ids, in errors, traces and
  // breadcrumbs (lib/sentryScrub.ts, SECURITY.md Rounds 34 and 43): a fetch breadcrumb carried a search
  // term, and /schools/<id>/students/<id> names a child.
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  // The replay is scrubbed at the transport, the one place that sees all of it (lib/sentryScrub.ts,
  // scrubEnvelope): the recorded page keeps link addresses and its own address, which no replay hook reaches.
  transport: (options: Parameters<typeof Sentry.makeFetchTransport>[0]) => scrubbingTransport(Sentry.makeFetchTransport(options)),
  // No replay where a page holds a credential: the sign-in pages and the platform-admin area
  // (replayAllowed). A page reached later by client-side navigation stops it (components/NoReplay).
  // Where it runs, the masking is stated, not inherited: the DPA's "technical/diagnostic data only"
  // for Sentry depends on it, and a replay must not carry what is on screen. Compression stays off so
  // the transport can read the recording to scrub it; one it cannot read is dropped, never sent.
  // lib/__tests__/sentryReplayConfig.test.ts fails if any of these is removed or the baseline raised.
  integrations:
    typeof window !== 'undefined' && replayAllowed(window.location.pathname)
      ? [Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true, useCompression: false })]
      : [],
});

// Next 15.3+ calls this on every client-side navigation. Next 14 never does; there the SDK finds
// and patches the App Router itself, so navigations are traced either way.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
