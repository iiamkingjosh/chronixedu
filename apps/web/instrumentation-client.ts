import * as Sentry from '@sentry/nextjs';

// The browser half of Sentry. Formerly sentry.client.config.ts. @sentry/nextjs v10 injects this
// file into the client bundle on webpack builds (Next 14); Next 15.3+ loads it natively, and the
// old name does not work under Turbopack.

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.1,
  // Stated, not inherited: these are the SDK's current defaults, and the DPA's "technical/
  // diagnostic data only" for Sentry depends on them — a replay must not carry what is on screen.
  integrations: [Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true })],
});

// Next 15.3+ calls this on every client-side navigation. Next 14 never does; there the SDK finds
// and patches the App Router itself, so navigations are traced either way.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
