/**
 * Jest globalSetup: runs ONCE before any test worker starts.
 *
 * Applies all .sql migrations against TEST_DATABASE_URL. Doing this here
 * (instead of in each test file's beforeAll) avoids the race where two
 * Jest workers both try to CREATE TABLE/INDEX in parallel and one fails
 * on a duplicate-key conflict in pg_type / pg_class.
 *
 * Skips silently when TEST_DATABASE_URL isn't set — the integration
 * suites describe.skip themselves in that case.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const TOLERATED_ERRORS = [
  /already exists/i,
  /duplicate object/i,
  /duplicate column/i,
  /duplicate key value violates unique constraint/i,
];

function isTolerated(err) {
  const msg = String(err.message || '');
  return TOLERATED_ERRORS.some(rx => rx.test(msg));
}

module.exports = async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return; // integration tests will skip

  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const dir = path.join(__dirname, '..', '..', 'migrations');
    const files = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
      try {
        await pool.query(sql);
      } catch (err) {
        if (!isTolerated(err)) {
          throw new Error(`Migration ${file} failed: ${err.message}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[global-setup] Applied ${files.length} migrations`);
  } finally {
    await pool.end();
  }
};
