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

  silent: false,
  verbose: false,

  // Coverage collection: only the modules with actual unit tests.
  // Route handlers + Kafka glue are integration territory; future
  // integration tests will need a running PG/Redis/Kafka stack.
  collectCoverageFrom: ['src/lib/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
};
