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

  // Coverage collection spans the shippable service code — the lib
  // helpers plus the dispatcher/connector/management services (the
  // riskiest delivery/retry/DLQ paths). `src/test/**` holds local load
  // harness scripts, not product code, so it's excluded to keep the
  // denominator honest.
  collectCoverageFrom: [
    'src/lib/**/*.js',
    'src/webhook-dispatcher/**/*.js',
    'src/subscription-connector/**/*.js',
    'src/subscription-management/**/*.js',
    '!src/test/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],

  // Hard gate (CI: `npm run test:coverage` -> `jest --coverage`). Calibrated
  // as a RATCHET that can only be raised, never a tripwire on the current
  // tree: every floor sits a few points UNDER the directly-measured baseline.
  // All numbers below were measured with `jest --coverage` and NO database
  // (`TEST_DATABASE_URL` unset) — the worst case — so the gate is guaranteed
  // to hold in CI whether or not Postgres is reachable.
  //
  // Two Jest semantics drive the calibration:
  //
  //   1. A path-specific key is *subtracted* from the `global` bucket — they
  //      cover disjoint files. The only per-dir key here is `src/lib`, so
  //      `global` measures dispatcher + connector + management combined.
  //   2. Without `TEST_DATABASE_URL` the seven integration suites describe.skip,
  //      so subscription-management's files are loaded (and thus counted in the
  //      denominator) but their bodies never run — it reads ~3%. That sinks the
  //      blended `global` number to ~36% (lines). CI runs the FULL suite, so
  //      the `global` floor MUST clear that no-DB low-water mark; a DB in CI
  //      only lifts it.
  //
  // `src/lib` is the real ratchet: pure, dependency-free helpers whose coverage
  // is identical in every environment (no Postgres needed), measured ~83% and
  // floored ~5 points under. `global` is a residual net on the service dirs —
  // dragged down by skipped management code, lifted by the well-tested
  // dispatcher (~86%) and connector (~81%) that dominate its numerator.
  //
  // Measured baseline (`jest --coverage`, no DB — the worst case):
  //   global = dispatcher+connector+mgmt   stmts 36 / branch 24 / funcs 32 / lines 36
  //     . src/webhook-dispatcher           stmts 86 / branch 85 / funcs 63 / lines 86
  //     . src/subscription-connector       stmts 79 / branch 68 / funcs 67 / lines 81
  //     . src/subscription-management      stmts  3 / branch  0 / funcs  0 / lines  3 (integration-only; skipped no-DB)
  //   src/lib                              stmts 83 / branch 79 / funcs 82 / lines 84
  // Raise these as suites land/stabilize — add a per-dir floor for dispatcher,
  // connector, and (once CI runs with a DB) management, and lift `global`
  // toward the DB-on aggregate (~47%+). Never lower them.
  coverageThreshold: {
    // Residual net for the service dirs not keyed below (dispatcher + connector
    // + management). Held under the ~36% no-DB blend — management reads ~3%
    // without a database — so the full-suite CI gate passes everywhere.
    global: {
      lines: 32,
      statements: 32,
      branches: 20,
      functions: 27,
    },
    // Pure, dependency-free helpers — identical coverage in every environment,
    // so this floor is stable in CI and locally. The strongest ratchet on the
    // most-tested code: ~5 points under the measured ~83/79/82/84.
    './src/lib/': {
      lines: 78,
      statements: 78,
      branches: 74,
      functions: 77,
    },
  },
};
