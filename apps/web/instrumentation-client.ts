import * as Sentry from '@sentry/nextjs';
import { scrubEvent, scrubBreadcrumb, replayAllowed, scrubbingTransport, dropNotifier, isDropNotice } from '@/lib/sentryScrub';

// The browser half of Sentry. Formerly sentry.client.config.ts. @sentry/nextjs v10 injects this
// file into the client bundle on webpack builds (Next 14); Next 15.3+ loads it natively, and the
// old name does not work under Turbopack.

// What the transport keeps back is said once per page load, by reason and item type, never silently
// (SECURITY.md Round 44): a replay dropped because it could not be scrubbed, or an item of a type not allowed.
const noteDrop = dropNotifier((message, tags) => Sentry.captureMessage(message, { level: 'warning', tags }));

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  // A replay is sent only when an error happens, never for a session in which nothing went wrong
  // (SECURITY.md Round 43). The DPA lists Sentry for error monitoring, "technical/diagnostic data only";
  // recording ordinary sessions is not error monitoring, and no legal page discloses it.
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
  // Addresses keep their path and lose query string, fragment and record ids, and a clicked element loses
  // its aria-label, title and alt text, in errors, traces and breadcrumbs (lib/sentryScrub.ts, SECURITY.md
  // Rounds 34, 43 and 44): a fetch breadcrumb carried a search term, /schools/<id>/students/<id> names a
  // child, and the promotions page labels each pupil's controls with the pupil's name.
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  // Everything is scrubbed again at the transport, the one place that sees all of it (lib/sentryScrub.ts,
  // scrubEnvelope): the replay and the INP span skip the hooks above, and only the item types it names are sent.
  transport: (options: Parameters<typeof Sentry.makeFetchTransport>[0]) =>
    scrubbingTransport(Sentry.makeFetchTransport(options), noteDrop),
  // No replay where a page holds a credential: the sign-in pages and the platform-admin area
  // (replayAllowed). A page reached later by client-side navigation stops it (components/NoReplay).
  // Where it runs, the masking is stated, not inherited: the DPA's "technical/diagnostic data only"
  // for Sentry depends on it, and a replay must not carry what is on screen. Compression stays off so
  // the transport can read the recording to scrub it; one it cannot read is dropped, never sent. A
  // notice of a drop cannot start a replay today (a message has no exception while attachStacktrace is
  // off); beforeErrorSampling keeps it so if that setting changes (lib/sentryScrub.ts, isDropNotice).
  // lib/__tests__/sentryReplayConfig.test.ts fails if any of these is removed or the baseline raised.
  integrations:
    typeof window !== 'undefined' && replayAllowed(window.location.pathname)
      ? [Sentry.replayIntegration({
          maskAllText: true,
          maskAllInputs: true,
          blockAllMedia: true,
          useCompression: false,
          beforeErrorSampling: (event) => !isDropNotice(event),
        })]
      : [],
});

// Next 15.3+ calls this on every client-side navigation. Next 14 never does; there the SDK finds
// and patches the App Router itself, so navigations are traced either way.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
