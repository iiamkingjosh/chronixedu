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
};
