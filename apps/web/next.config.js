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
    // Security headers (CSP, X-Frame-Options, etc.) are set per-request in
    // middleware.ts so a fresh nonce can be generated for each request.
    // Only static-asset cache-control headers live here.
    return [
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
