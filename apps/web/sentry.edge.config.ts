import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from '@/lib/sentryScrub';

// The edge runtime (middleware). Loaded by register() in instrumentation.ts.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  // Paths only: no query string or fragment (lib/sentryScrub.ts, SECURITY.md Round 34).
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
});
