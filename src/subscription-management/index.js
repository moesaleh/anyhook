/**
 * Subscription management service entry point.
 *
 * Bootstraps real clients (pg, redis, kafka) and hands them to createApp()
 * for route mounting. The Express app construction lives in ./app.js so it
 * can be exercised by integration tests with mocked deps.
 */

require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const { Pool } = require('pg');
const redis = require('@redis/client');
const { Kafka, logLevel } = require('kafkajs');
const { exec } = require('child_process');
const { createLogger } = require('../lib/logger');
const { makeRateLimit, ipKeyFn, userOrgKeyFn } = require('../lib/rate-limit');
const { startMetricsServer } = require('../lib/metrics-server');
const { createApp } = require('./app');

const log = createLogger('subscription-management');
// startMetricsServer() handles default-metrics collection — don't double-register.

function parseBrokers(envValue) {
  return (envValue || 'localhost:9092')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const PORT = process.env.PORT || 3001;

// --- Clients ---

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => log.error('Redis Client Error', err));

const kafka = new Kafka({
  clientId: 'subscription-management',
  brokers: parseBrokers(process.env.KAFKA_HOST),
  logLevel: logLevel.WARN,
});
// idempotent:true makes the producer exactly-once *per partition* on the
// broker (dedup by producer-id + sequence), which is what gives the outbox
// drainer durable at-least-once end-to-end. KafkaJS forces acks=-1 ('all')
// whenever idempotent is set and rejects any weaker acks, so durability is
// implied — we don't (and can't) also pass acks here. Idempotence additionally
// requires maxInFlightRequests<=1 (KafkaJS throws otherwise); 1 also preserves
// per-key ordering. Works on single-node dev (RF=1) — idempotence is a
// producer/broker protocol feature, independent of replication factor.
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 1,
});
const admin = kafka.admin();

// --- Middlewares (need redisClient already constructed) ---

// RATE_LIMIT_PER_USER=true switches the keyFn from per-org to per-user-
// per-org so a noisy admin polling the dashboard doesn't consume the
// whole org's budget. API-key auth (no userId) still falls back to
// per-org so a robot can't bypass the limit. Per-user limits also
// preclude the per-org override lookup (no per-user override row),
// so only enable when the per-user shape matches the product policy.
const RATE_LIMIT_PER_USER = process.env.RATE_LIMIT_PER_USER === 'true';
const rateLimit = makeRateLimit({
  redisClient,
  pool, // enables per-org override lookup against organizations.rate_limit_*
  limit: parseInt(process.env.RATE_LIMIT_REQUESTS, 10) || undefined,
  windowSec: parseInt(process.env.RATE_LIMIT_WINDOW_SEC, 10) || undefined,
  keyFn: RATE_LIMIT_PER_USER ? userOrgKeyFn : undefined,
  logger: log,
});

const authRateLimit = makeRateLimit({
  redisClient,
  limit: parseInt(process.env.AUTH_RATE_LIMIT_REQUESTS, 10) || 10,
  windowSec: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_SEC, 10) || 60,
  prefix: 'auth-rl',
  keyFn: ipKeyFn,
  logger: log,
});

function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res
      .status(503)
      .json({ error: 'Admin endpoints disabled: ADMIN_API_KEY not configured' });
  }
  if (req.headers['x-admin-key'] !== adminKey) {
    return res.status(403).json({ error: 'Forbidden: invalid or missing admin key' });
  }
  next();
}

// --- App ---

const app = createApp({
  pool,
  redisClient,
  producer,
  admin,
  log,
  rateLimit,
  authRateLimit,
  requireAdminKey,
});

// --- Lifecycle ---

// Migrations are NO LONGER run on app boot by default.
//
// Boot-time migration shelled out per API pod, which (a) crash-looped any
// image where the migrate tool wasn't on PATH and (b) raced across multi-pod
// boots — several pods running `node-pg-migrate up` against the same DB at
// once. The contract now: schema is brought current by a dedicated one-shot
// step BEFORE the API rolls out (the compose `migrate` service / a CI
// pre-deploy job, both running `npx node-pg-migrate up` once per release).
// App pods assume the schema is already current and only *verify* it
// (assertSchemaReady) so a forgotten migration fails fast with a clear
// message instead of surfacing as confusing 500s later.
//
// RUN_MIGRATIONS_ON_BOOT=true restores the old run-on-boot behavior as a
// single-node dev convenience. It defaults OFF in production and ON otherwise
// so `npm run dev` against a fresh DB still self-migrates. We invoke
// `npx node-pg-migrate up` directly (not `npm run migrate`) so it works
// whether node-pg-migrate resolves from dependencies or a dev-only install.
function runMigrationsOnBoot() {
  const explicit = process.env.RUN_MIGRATIONS_ON_BOOT;
  if (explicit !== undefined) return explicit === 'true';
  // Unset: default off in production, on elsewhere (dev convenience).
  return process.env.NODE_ENV !== 'production';
}

function applyMigrations() {
  return new Promise((resolve, reject) => {
    log.info('RUN_MIGRATIONS_ON_BOOT enabled — applying database migrations...');
    // npx resolves node-pg-migrate from node_modules/.bin when present and
    // otherwise fetches it; either way avoids depending on `npm run migrate`.
    exec('npx node-pg-migrate up', (err, stdout, stderr) => {
      if (err) {
        log.error('Error applying migrations:', stderr);
        reject(err);
      } else {
        log.info('Migrations applied successfully:', stdout);
        resolve();
      }
    });
  });
}

// Fail fast (with a clear, actionable message) if the schema looks un-migrated.
// `subscriptions` is the oldest core table — its absence means migrations
// never ran for this release. We probe with to_regclass so a missing table is
// a clean NULL rather than an error, and only escalate on the un-migrated case
// (transient connection errors are left to the normal startup error path).
async function assertSchemaReady() {
  const { rows } = await pool.query("SELECT to_regclass('public.subscriptions') AS tbl");
  if (!rows[0] || rows[0].tbl === null) {
    throw new Error(
      'Database schema not initialized: expected table "subscriptions" is missing. ' +
        'Run migrations before starting the API (one-shot `migrate` service / CI job, ' +
        'or set RUN_MIGRATIONS_ON_BOOT=true for local dev).'
    );
  }
  log.info('Schema readiness check passed (subscriptions table present)');
}

async function createKafkaTopics() {
  // numPartitions controls horizontal scaling. With N partitions, up to N
  // connector / dispatcher pods can run in parallel — Kafka assigns each
  // partition to exactly one consumer per group. Producers set
  // key=subscriptionId so the same subscription always lands on the
  // same partition (preserves event ordering for that sub).
  //
  // KAFKA_PARTITIONS env tunable — default 8. NOTE: increasing this for an
  // existing topic requires `kafka-topics.sh --alter --partitions N`;
  // createTopics is a no-op if the topic already exists.
  const numPartitions = parseInt(process.env.KAFKA_PARTITIONS, 10) || 8;
  // KAFKA_REPLICATION_FACTOR env tunable — default 1 for single-node dev.
  // PRODUCTION EXPECTATION: run a >=3-node quorum and set this to >=3 with
  // broker `min.insync.replicas=2`, so a broker/volume loss can't drop
  // undelivered events (RF=1 is a SPOF). The idempotent producer above only
  // dedups; it does NOT replicate — durability across broker failure is RF's
  // job. createTopics is a no-op on existing topics, so bumping RF afterwards
  // needs a reassignment (kafka-reassign-partitions), not just this env var.
  const replicationFactor = parseInt(process.env.KAFKA_REPLICATION_FACTOR, 10) || 1;
  const topicsToCreate = [
    { topic: 'subscription_events', numPartitions, replicationFactor },
    { topic: 'unsubscribe_events', numPartitions, replicationFactor },
    { topic: 'connection_events', numPartitions, replicationFactor },
    { topic: 'update_events', numPartitions, replicationFactor },
    { topic: 'dlq_events', numPartitions, replicationFactor },
  ];
  const created = await admin.createTopics({
    topics: topicsToCreate,
    waitForLeaders: true,
  });
  log.info(
    `Kafka topics ready (created=${created}, partitions=${numPartitions}, replication=${replicationFactor})`
  );
}

// Internal HTTP for /metrics + /health on METRICS_PORT (default 9090).
// Same pattern as the worker services — docker-compose does NOT map this
// port publicly, so Prometheus scrapes over the internal network and
// /metrics is no longer reachable from the public API surface.
const metricsServer = startMetricsServer({ logger: log });

let server;
// Set when shutdown is driven by a fatal process-level error (see below) so
// the graceful path can exit non-zero. Also guards against a second shutdown
// (e.g. a SIGTERM arriving mid-crash-shutdown) re-entering and racing exit.
let fatalError = false;
let shuttingDown = false;
(async () => {
  try {
    await redisClient.connect();
    log.info('Redis client connected');

    if (runMigrationsOnBoot()) {
      await applyMigrations();
    } else {
      // Schema is expected to be current (migrated by the dedicated one-shot
      // job before rollout). Verify rather than mutate, and fail fast if not.
      await assertSchemaReady();
    }
    await admin.connect();
    await producer.connect();
    await createKafkaTopics();

    server = app.listen(PORT, () => {
      log.info(`Subscription Management Service listening on port ${PORT}`);
    });
  } catch (err) {
    log.error('Failed to start Subscription Management service:', err);
    process.exit(1);
  }
})();

async function shutdown(signal) {
  if (shuttingDown) return; // idempotent — ignore a second signal/fatal event
  shuttingDown = true;
  log.info(`Subscription management received ${signal}, shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    log.error('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10000);
  try {
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([
      new Promise(resolve => metricsServer.close(resolve)),
      producer.disconnect(),
      admin.disconnect(),
      redisClient.quit(),
      pool.end(),
    ]);
  } catch (err) {
    log.error('Error during shutdown:', err);
  } finally {
    clearTimeout(forceExit);
    // Signals are a clean exit (0); a fatal process-level error is not (1).
    process.exit(fatalError ? 1 : 0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last-resort handlers for errors that escape all try/catch. There is heavy
// fire-and-forget async work in this service (outbox-adjacent producer sends,
// notifications) and on Node >=22 an unhandled rejection terminates the
// process by default — better to log the cause and drain via the same
// graceful path (close server/Kafka/Redis/pg) than to die abruptly mid-request
// or, worse, keep running in an undefined state. We exit non-zero so the
// orchestrator restarts the pod.
process.on('unhandledRejection', reason => {
  fatalError = true;
  log.error('Unhandled promise rejection — shutting down', reason);
  shutdown('unhandledRejection');
});
process.on('uncaughtException', err => {
  fatalError = true;
  log.error('Uncaught exception — shutting down', err);
  shutdown('uncaughtException');
});
