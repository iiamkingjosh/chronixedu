// No `images` block, on purpose. CI's security gate (scripts/audit-gate.js) accepts the
// critical AVIF advisory on next@14 only while this file gives the image optimizer no source
// an attacker controls: adding `remotePatterns`, `domains` or a `loader` here fails CI until
// that exception is re-decided (scripts/audit-allowlist.json). The real fix is next 15.5.24.
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
      // Authenticated API responses must never be served from cache.
      {
        urlPattern: /\/api\//,
        handler: 'NetworkOnly',
      },
      // School files (logos, signatures, photos, homework) come from a private bucket through links
      // that expire. Never kept on the device: a cached copy would outlive its link (5 Oct 2026).
      {
        urlPattern: /\.supabase\.co\/storage\//,
        handler: 'NetworkOnly',
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

  // Next 14 runs instrumentation.ts only with this flag. That file is what loads Sentry's server
  // and edge configs; without it the server half of Sentry never initialised. Next 15 makes
  // instrumentation stable and removes the flag.
  experimental: {
    instrumentationHook: true,
  },

  async headers() {
    // Security headers (CSP, X-Frame-Options, etc.) are set per-request in
    // middleware.ts so a fresh nonce can be generated for each request.
    // Permissions-Policy and Referrer-Policy are static and live here.
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
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
