import type { CorsOptions } from 'cors';

/**
 * How long a browser may reuse a CORS preflight: 7,200 seconds, Chrome's cap (Firefox allows longer,
 * so Chrome's limit is the binding one).
 *
 * The web app (edu.chronixtechnology.com) and the API (api.chronixtechnology.com) are different
 * origins, and a JSON POST is not a "simple" request. So every API call waits for an OPTIONS round
 * trip unless the browser has one cached for that URL. Without this header Chrome keeps a preflight
 * for 5 seconds, so every sign-in and nearly every page load paid one.
 *
 * Measured 2 Oct 2026 from the login page, Chrome 127, Lagos, API in Railway `sfo`. Chrome counts the
 * whole preflight as the real request's "Queueing":
 * - 2,319 ms cold: connection setup plus the preflight;
 * - 376 ms on a warm connection, once the 5 seconds had passed;
 * - 1 ms with the preflight cached.
 * That is the 0.88–2.90 s of Queueing in the 1 Oct sign-in baseline.
 *
 * The cost of caching: a browser reuses a cached preflight for up to 2 hours. A tightened CORS_ORIGIN
 * therefore takes up to 2 hours to bite for browsers that have already visited. If a change to the
 * origin list seems not to have deployed, wait that out before debugging it.
 *
 * Caching only mitigates the preflight. Serving the API under the web origin would remove it, and is
 * deliberately not done; CLAUDE.md (Auth) records why.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;

export function corsOptions(allowedOrigins: readonly string[]): CorsOptions {
  return {
    origin: (origin, cb) => {
      // Disallowed origins get cb(null, false) — cors omits the Allow-Origin header
      // so browsers block the response, without throwing into a 500 that would
      // otherwise echo the rejected origin back in the error body.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
}
