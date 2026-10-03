'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * Stops Sentry session replay for the rest of this page load (SECURITY.md Round 34). Mounted by the
 * sign-in layout and the platform-admin layout. instrumentation-client.ts never starts replay when a
 * page load begins on one of those paths (lib/sentryScrub.ts, replayAllowed); this covers arriving by
 * client-side navigation from a page where it was running. Replay stays off until the next full page
 * load, which costs a little debugging and nothing else.
 */
export default function NoReplay() {
  useEffect(() => {
    const replay = Sentry.getReplay();
    if (replay) replay.stop().catch((err: unknown) => Sentry.captureException(err));
  }, []);
  return null;
}
