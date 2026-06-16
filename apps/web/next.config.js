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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = withPWA(nextConfig);
