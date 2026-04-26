/**
 * Jest config for the JS backend.
 *
 * Discovers tests in `tests/` (kept separate from src/ so coverage
 * collection is clean and source files stay free of __tests__ noise).
 * The previous config used `ts-jest` against TypeScript files that
 * never existed in this codebase — that's been removed.
 */

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],

  // Run migrations once before any worker starts so parallel test files
  // don't race on CREATE TABLE / CREATE INDEX / pg_type allocation.
  globalSetup: '<rootDir>/tests/integration/global-setup.js',

  // Run tests serially. Unit tests are fast (~1s for 117); the integration
  // suites share a single Postgres database and TRUNCATE between tests, so
  // parallel files would race on each other's data. Cleanest option here:
  // single worker. Bumping back to parallel needs per-file DB schemas.
  maxWorkers: 1,

  silent: false,
  verbose: false,

  // Coverage collection: only the modules with actual unit tests.
  // Route handlers + Kafka glue are integration territory; future
  // integration tests will need a running PG/Redis/Kafka stack.
  collectCoverageFrom: ['src/lib/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
};
