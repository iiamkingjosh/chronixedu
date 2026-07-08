import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Generate a unique nonce for every request. The nonce is injected into
  // script-src so only Next.js's own generated scripts (RSC payload, hydration
  // chunks) are allowed — without needing 'unsafe-inline'.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const isDev = process.env.NODE_ENV !== 'production';

  const connectSrc = [
    "'self'",
    'https://api.chronixtechnology.com',
    'https://chronixeduapi-production.up.railway.app',
    'https://pgnpmqaowrnmsytpehwc.supabase.co',
    'wss://pgnpmqaowrnmsytpehwc.supabase.co',
    'https://*.ingest.us.sentry.io',
    'https://*.ingest.sentry.io',
    ...(isDev ? ['http://localhost:3001'] : []),
  ].join(' ');

  // 'unsafe-inline' is included alongside the nonce as a fallback for older
  // browsers. CSP Level 3 browsers that understand nonces automatically ignore
  // 'unsafe-inline', so the nonce remains the effective gate in modern browsers.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'unsafe-inline' https://js.paystack.co`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  // x-nonce is read by Next.js's RSC renderer and applied to all generated
  // inline <script> tags automatically (hydration, RSC payload streaming, etc.)
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  return response;
}

export const config = {
  matcher: [
    // Apply to all routes except Next.js static assets, images, and icons
    // (those don't need a per-request nonce and are served with immutable cache)
    '/((?!_next/static|_next/image|favicon.ico|icons|manifest.json|sw.js).*)',
  ],
};
