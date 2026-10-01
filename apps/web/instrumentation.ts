import * as Sentry from '@sentry/nextjs';

/**
 * Sentry's server and edge initialisation. Next.js calls register() once per server runtime at
 * start-up; on Next 14 only because next.config.js sets experimental.instrumentationHook.
 *
 * Until this file existed, sentry.server.config.ts was never loaded (the build warned about it),
 * so the server half of Sentry never ran, and middleware (edge runtime) had no init at all. The
 * browser half was unaffected: @sentry/nextjs injects instrumentation-client.ts on webpack builds.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Next 15's request-error hook. Next 14 never calls it; it is ready for the Next 15 upgrade.
export const onRequestError = Sentry.captureRequestError;
