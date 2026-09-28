// DB-backed regression suite (AUDIT 2026-09). Runs the real routers against a
// disposable Postgres rebuilt from /migrations. See jest.db.globalSetup.ts for
// the safety checks that stop it from ever touching a real database.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__db_tests__'],
  testMatch: ['**/*.db.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  globalSetup: '<rootDir>/jest.db.globalSetup.ts',
  setupFiles: ['<rootDir>/src/__db_tests__/env.ts'],
  // Jest's default is 5000ms, which is a generic number and far too tight for this
  // suite's `beforeEach(seed)` — seed() TRUNCATEs every tenant table CASCADE and reinserts
  // a full two-school fixture. On a loaded machine it exceeds 5s, and the failure that
  // follows does not look like a timeout: Jest abandons the hook but the in-flight INSERT
  // keeps running and lands AFTER the next test's TRUNCATE, so the next test dies with
  // `duplicate key value violates unique constraint "schools_pkey"`. One slow seed takes
  // out a variable number of later tests in a variable suite, which is exactly why it read
  // as an unreproducible 1-in-8 flake for two days.
  //
  // 30s is a budget matched to the work, not a number picked to make a failure go away:
  // individual suites here already run for 45s+, and a seed that genuinely takes 30s is a
  // real regression worth failing on.
  testTimeout: 30000,
};
