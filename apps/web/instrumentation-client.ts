import * as Sentry from '@sentry/nextjs';
import { scrubEvent, scrubBreadcrumb, replayAllowed } from '@/lib/sentryScrub';

// The browser half of Sentry. Formerly sentry.client.config.ts. @sentry/nextjs v10 injects this
// file into the client bundle on webpack builds (Next 14); Next 15.3+ loads it natively, and the
// old name does not work under Turbopack.

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.1,
  // Addresses keep their path and lose query string and fragment, in errors, traces and breadcrumbs
  // (lib/sentryScrub.ts, SECURITY.md Round 34): a fetch breadcrumb carried a search term.
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  // No replay where a page holds a credential: the sign-in pages and the platform-admin area
  // (replayAllowed). A page reached later by client-side navigation stops it (components/NoReplay).
  // Where it runs, the masking is stated, not inherited: the DPA's "technical/diagnostic data only"
  // for Sentry depends on it, and a replay must not carry what is on screen.
  integrations:
    typeof window !== 'undefined' && replayAllowed(window.location.pathname)
      ? [Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true })]
      : [],
});

// Next 15.3+ calls this on every client-side navigation. Next 14 never does; there the SDK finds
// and patches the App Router itself, so navigations are traced either way.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
