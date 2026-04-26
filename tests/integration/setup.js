/**
 * Integration test harness.
 *
 * Builds a real Express app via createApp() with:
 *   - a real PG pool (against TEST_DATABASE_URL)
 *   - an in-memory Redis stub (just enough surface for the routes used here)
 *   - no-op Kafka producer + admin (Kafka isn't exercised in these tests)
 *
 * Tests use supertest to make HTTP calls against the app. cleanDatabase()
 * truncates tenant tables between tests so each starts from a known state.
 *
 * Tests are skipped at runtime if TEST_DATABASE_URL is not set — they
 * require a live Postgres instance. CI provisions one as a service.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createApp } = require('../../src/subscription-management/app');
const { createLogger } = require('../../src/lib/logger');
const { makeRateLimit, ipKeyFn } = require('../../src/lib/rate-limit');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Skip a describe block when no PG is configured. Use:
 *   describeIfPg('thing', () => { ... })
 */
const describeIfPg = TEST_DATABASE_URL ? describe : describe.skip;

/** In-memory Redis stub. Implements just what the app routes use. */
function inMemoryRedis() {
  const store = new Map();
  return {
    async connect() {},
    on() {},
    async quit() {},
    async ping() {
      return 'PONG';
    },
    async set(k, v) {
      store.set(k, v);
      return 'OK';
    },
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async del(k) {
      return store.delete(k) ? 1 : 0;
    },
    async incr(k) {
      const n = (Number(store.get(k)) || 0) + 1;
      store.set(k, n);
      return n;
    },
    async expire() {
      return 1;
    },
    async keys() {
      return [...store.keys()];
    },
    async scan(cursor, opts) {
      // One-shot scan: return everything on the first call, end on the second.
      if (cursor === 0) {
        const count = (opts && opts.COUNT) || 100;
        const keys = [...store.keys()].slice(0, count);
        return { cursor: 0, keys };
      }
      return { cursor: 0, keys: [] };
    },
    async flushAll() {
      store.clear();
      return 'OK';
    },
    multi() {
      const ops = [];
      const chain = {
        get(k) {
          ops.push(['get', k]);
          return chain;
        },
        async exec() {
          return ops.map(([cmd, k]) =>
            cmd === 'get' ? (store.has(k) ? store.get(k) : null) : null
          );
        },
      };
      return chain;
    },
  };
}

/** No-op kafka producer/admin — calls succeed silently. */
function noopProducer() {
  return {
    async connect() {},
    async disconnect() {},
    async send() {
      return [{ topicName: 'noop', errorCode: 0 }];
    },
  };
}
function noopAdmin() {
  return {
    async connect() {},
    async disconnect() {},
    async listTopics() {
      return [];
    },
    async createTopics() {
      return true;
    },
    async deleteTopics() {},
  };
}

/**
 * Run all .sql migrations in order, idempotently.
 *
 * Each migration is wrapped in a transaction. If the schema is already up
 * (e.g. another test process applied it), the IF NOT EXISTS / ON CONFLICT
 * clauses in our migrations make this safe.
 */
async function applyMigrations(pool) {
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
      // Tolerate "already exists" classes of errors so the suite is
      // re-runnable. Any other error is fatal.
      const msg = String(err.message || '');
      if (
        !/already exists/i.test(msg) &&
        !/duplicate object/i.test(msg) &&
        !/duplicate column/i.test(msg)
      ) {
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  }
}

let pool;
let app;

async function setupTestApp() {
  if (!TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must be set to run integration tests');
  }
  // The auth module reads JWT_SECRET at sign/verify time, so set it here.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-jwt-secret-pad-32+chars';

  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  await applyMigrations(pool);

  const log = createLogger('test-app');
  // Generous limits so the suite never trips them by accident
  const redisClient = inMemoryRedis();
  const rateLimit = makeRateLimit({
    redisClient,
    limit: 100000,
    windowSec: 60,
    logger: log,
  });
  const authRateLimit = makeRateLimit({
    redisClient,
    limit: 100000,
    windowSec: 60,
    prefix: 'auth-rl-test',
    keyFn: ipKeyFn,
    logger: log,
  });

  app = createApp({
    pool,
    redisClient,
    producer: noopProducer(),
    admin: noopAdmin(),
    log,
    rateLimit,
    authRateLimit,
    // Admin endpoints aren't exercised by the auth/tenancy suite; reject
    // anything that hits them so a typo can't accidentally exercise them.
    requireAdminKey: (req, res) =>
      res.status(503).json({ error: 'admin endpoints disabled in tests' }),
  });

  return { app, pool };
}

async function teardownTestApp() {
  if (pool) {
    await pool.end();
    pool = null;
    app = null;
  }
}

/** Truncate tenant tables between tests so each starts clean. */
async function cleanDatabase() {
  if (!pool) return;
  await pool.query(`
    TRUNCATE TABLE
      pending_retries,
      delivery_events,
      subscriptions,
      api_keys,
      memberships,
      users,
      organizations
    RESTART IDENTITY CASCADE
  `);
}

/** Helper: extract the session cookie value (just the cookie pair) for reuse. */
function getSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const match = arr.find(c => c.startsWith('anyhook_session='));
  if (!match) return null;
  // Just the "anyhook_session=<value>" part, no attributes
  return match.split(';')[0];
}

module.exports = {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
  TEST_DATABASE_URL,
};
