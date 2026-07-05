const withPWA = require('@ducanh2912/next-pwa').default({
  dest: 'public',
  register: false, // registered manually in components/PwaRegister.tsx (app router has no _document)
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  workboxOptions: {
    runtimeCaching: [
      // Roster data needed offline by teachers: class list, attendance roster, score sheets, term context.
      {
        urlPattern: /\/api\/schools\/[^/]+\/classes(\?.*)?$/,
        handler: 'NetworkFirst',
        options: {
          cacheName: 'chronixedu-roster-classes',
          expiration: { maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 },
          networkTimeoutSeconds: 5,
        },
      },
      {
        urlPattern: /\/api\/schools\/[^/]+\/attendance\/class(\?.*)?$/,
        handler: 'NetworkFirst',
        options: {
          cacheName: 'chronixedu-roster-attendance',
          expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
          networkTimeoutSeconds: 5,
        },
      },
      {
        urlPattern: /\/api\/schools\/[^/]+\/scores\/class-sheet(\?.*)?$/,
        handler: 'NetworkFirst',
        options: {
          cacheName: 'chronixedu-roster-scores',
          expiration: { maxEntries: 64, maxAgeSeconds: 24 * 60 * 60 },
          networkTimeoutSeconds: 5,
        },
      },
      {
        urlPattern: /\/api\/schools\/[^/]+\/current-context(\?.*)?$/,
        handler: 'NetworkFirst',
        options: {
          cacheName: 'chronixedu-roster-context',
          expiration: { maxEntries: 8, maxAgeSeconds: 24 * 60 * 60 },
          networkTimeoutSeconds: 5,
        },
      },
      // Default app-shell / Next.js asset caching
      {
        urlPattern: /^https?.*/,
        handler: 'NetworkFirst',
        options: {
          cacheName: 'chronixedu-app-shell',
          expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 },
          networkTimeoutSeconds: 10,
        },
      },
    ],
  },
});

const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  async headers() {
    const csp = [
      "default-src 'self'",
      // unsafe-inline and unsafe-eval removed — XSS fix (H-02)
      "script-src 'self' https://js.paystack.co",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // Service worker (PWA) needs blob: in worker-src
      "worker-src 'self' blob:",
      // API, Supabase realtime, Sentry error reporting
      [
        "connect-src 'self'",
        "https://api.chronixtechnology.com",
        "https://chronixeduapi-production.up.railway.app",
        "https://pgnpmqaowrnmsytpehwc.supabase.co",
        "wss://pgnpmqaowrnmsytpehwc.supabase.co",
        "https://*.ingest.us.sentry.io",
        "https://*.ingest.sentry.io",
        // Local API dev server — never included in production builds
        ...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3001']),
      ].join(' '),
      "frame-ancestors 'self'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options',        value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',      value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'X-XSS-Protection',        value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
      {
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/fonts/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

const sentryConfig = {
  silent: true,
  hideSourceMaps: true,
  disableLogger: true,
};

module.exports = withSentryConfig(withPWA(nextConfig), sentryConfig);
