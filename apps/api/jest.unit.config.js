// Unit tests only: src/__tests__/** mock `pg` entirely, so they need no database
// and must NOT load jest.globalSetup.ts (which reads apps/api/.env, connects,
// and — since AUDIT H-5 — refuses to run against a remote database). Keeping a
// separate config means a developer whose .env points at the shared DB can still
// run unit tests, while integration fixtures stay gated.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
};
