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
  // This is the OUTER BACKSTOP, not the guard. A Jest timeout stops waiting; it does not
  // stop the work — raising this alone would lower the frequency of the cascade and keep
  // the mechanism. The guard is in helpers.ts: seed() runs as one transaction with
  // statement_timeout and idle_in_transaction_session_timeout set to 20s, BELOW this, so
  // Postgres aborts and rolls back first and the failure lands in the test that owns it.
  // Keep this value above those two, or the race goes back to Jest.
  testTimeout: 30000,
};
