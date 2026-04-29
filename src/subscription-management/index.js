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
const { makeRateLimit, ipKeyFn } = require('../lib/rate-limit');
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
const producer = kafka.producer({ allowAutoTopicCreation: false });
const admin = kafka.admin();

// --- Middlewares (need redisClient already constructed) ---

const rateLimit = makeRateLimit({
  redisClient,
  pool, // enables per-org override lookup against organizations.rate_limit_*
  limit: parseInt(process.env.RATE_LIMIT_REQUESTS, 10) || undefined,
  windowSec: parseInt(process.env.RATE_LIMIT_WINDOW_SEC, 10) || undefined,
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

function applyMigrations() {
  return new Promise((resolve, reject) => {
    log.info('Applying database migrations...');
    exec('npm run migrate', (err, stdout, stderr) => {
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
(async () => {
  try {
    await redisClient.connect();
    log.info('Redis client connected');

    await applyMigrations();
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
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
