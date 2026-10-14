/** @type {import('jest').Config} */
// The web app's unit tests: pure TypeScript under lib/, no DOM, no Next runtime. Runs with
// the jest and ts-jest already hoisted at the repo root; `npm run test:unit` at the root
// runs it after the API's suite, so CI does too.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/lib/**/*.test.ts'],
  // The app's own alias, so a test can load a file that uses it (sentryReplayConfig.test.ts loads
  // instrumentation-client.ts as the browser does).
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', isolatedModules: true, esModuleInterop: true, strict: true } }],
  },
};
