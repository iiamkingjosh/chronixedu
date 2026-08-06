module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  // No globalTeardown: the shared fixture rows below are meant to persist across
  // invocations. globalSetup re-creates them idempotently (ON CONFLICT DO NOTHING),
  // so there is no need to delete them — doing so made any test file that depends
  // on this fixture fragile against any other concurrent or closely-timed Jest run.
  globalSetup: '<rootDir>/jest.globalSetup.ts',
};
