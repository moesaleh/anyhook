require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const redis = require('@redis/client');
const { Kafka, logLevel, Partitioners } = require('kafkajs');
const { Pool } = require('pg');
const promClient = require('prom-client');
const { createLogger } = require('../lib/logger');
const { startMetricsServer } = require('../lib/metrics-server');
const {
  subscriptionCacheKey,
  subscriptionIdFromKey,
  SUBSCRIPTION_KEY_PATTERN,
} = require('../lib/subscription-cache');
const GraphQLHandler = require('./handlers/graphqlHandler');
const WebSocketHandler = require('./handlers/webSocketHandler');

const log = createLogger('subscription-connector');

// Service-specific metrics
const subscriptionEventsHandled = new promClient.Counter({
  name: 'connector_subscription_events_total',
  help: 'Total Kafka events handled by the connector',
  labelNames: ['topic', 'outcome'],
});

// Per-instance open upstream connection gauge (P1-2). Self-registers on the
// default prom-client registry; its value is computed lazily on each scrape
// by summing each handler's live connection count so it can never drift from
// reality. With partition-ownership sharding the sum across all connector
// pods should ~equal the active subscription count (no N-fold duplication).
// No variable binding — the collect() callback is the only consumer.
new promClient.Gauge({
  name: 'connector_open_connections',
  help: 'Open upstream connections held by this connector instance, by type',
  labelNames: ['type'],
  collect() {
    for (const [type, handler] of Object.entries(connectionHandlers)) {
      this.set({ type }, handler.activeCount ? handler.activeCount() : 0);
    }
  },
});

// Number of Kafka partitions currently assigned to THIS pod for the
// subscription topics. Lets an operator see the shard split at a glance.
const ownedPartitionsGauge = new promClient.Gauge({
  name: 'connector_owned_partitions',
  help: 'Number of subscription-topic partitions assigned to this connector instance',
});

function parseBrokers(envValue) {
  return (envValue || 'localhost:9092')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// --- Partition-ownership sharding (P1-2) ---
//
// Every connector pod used to SCAN all sub:* and connect to EVERY upstream,
// so N pods opened N duplicate connections to each source and N copies of
// every event reached the dispatcher. The fix is to connect only to the
// subscriptions whose Kafka partition this pod owns.
//
// Subscriptions are keyed onto subscription_events / update_events /
// unsubscribe_events by key=subscriptionId, all with KAFKA_PARTITIONS
// partitions. Kafka's consumer group already assigns each partition to
// exactly one pod; for the reconnect-from-Redis path (which scans the whole
// cache, not a Kafka feed) we must reproduce the SAME mapping the producer
// used so "do I own this sub?" agrees with where its events land.
//
// We reuse kafkajs's DefaultPartitioner (murmur2 + toPositive % numPartitions)
// rather than re-implementing the hash, so connector and producer can never
// disagree. The consumer's runtime partition assignment is learned from the
// GROUP_JOIN instrumentation event and recomputed on every rebalance.
const KAFKA_PARTITIONS = parseInt(process.env.KAFKA_PARTITIONS, 10) || 8;
// Topic used as the canonical ownership signal — all sub-related topics
// share the same partition count + key, so owning partition p of this topic
// means owning partition p of the others too.
const OWNERSHIP_TOPIC = 'subscription_events';
// Cap concurrent upstream (re)connects when (re)loading so a rebalance or
// boot doesn't fire a thundering herd of simultaneous dials. Tunable; small
// default keeps the reconnect storm bounded.
const RELOAD_CONCURRENCY = parseInt(process.env.RELOAD_CONCURRENCY, 10) || 8;

// Build the default partitioner once and feed it a fixed partitionMetadata
// of length KAFKA_PARTITIONS so it returns toPositive(murmur2(key)) % N —
// exactly what the management producer computes for a keyed message.
const _defaultPartitioner = Partitioners.DefaultPartitioner();
const _partitionMetadata = Array.from({ length: KAFKA_PARTITIONS }, (_, i) => ({
  partitionId: i,
  leader: i,
}));
function partitionFor(subscriptionId) {
  return _defaultPartitioner({
    topic: OWNERSHIP_TOPIC,
    partitionMetadata: _partitionMetadata,
    message: { key: subscriptionId },
  });
}

// Partitions currently assigned to this pod (recomputed on each GROUP_JOIN).
let ownedPartitions = new Set();
// Becomes true after the first GROUP_JOIN so we know the initial reload has
// run (we defer it until assignment is known instead of reloading at boot).
let initialReloadDone = false;

function ownsSubscription(subscriptionId) {
  return ownedPartitions.has(partitionFor(subscriptionId));
}

/**
 * Tiny inline concurrency limiter (no new deps). Returns a function that
 * wraps an async task and ensures no more than `max` run at once. Used to
 * cap the reconnect fan-out on reload/rebalance. (P1-2)
 */
function pLimit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return fn =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
// Postgres pool for the Redis-miss fallback (P1-10). A flush/eviction of
// Redis used to silently darken every live connection because config was
// read from Redis only; we now fall back to the source of truth (the
// subscriptions table) and re-warm Redis. Best-effort: if PG is down the
// connector still runs off Redis.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.CONNECTOR_PG_POOL_MAX, 10) || 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
let pgAvailable = false;

const kafka = new Kafka({
  clientId: 'subscription-connector',
  brokers: parseBrokers(process.env.KAFKA_HOST),
  logLevel: logLevel.WARN,
});
// Producer durability (P1-8): acks:'all' + idempotent so an outbound
// connection_events publish survives a broker failover without silent loss
// or duplication. idempotent:true implies acks=-1 and bounds in-flight
// requests; we set maxInFlightRequests=5 explicitly (kafkajs's idempotent
// ceiling) to document the cap.
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  maxInFlightRequests: 5,
  retry: { retries: 10 },
});
const consumer = kafka.consumer({ groupId: 'subscription-connector' });

// Connection handlers (pluggable). Constructed once with the shared producer
// + redis client; one instance handles ALL subscriptions of its type.
const connectionHandlers = {
  graphql: new GraphQLHandler(producer, redisClient),
  websocket: new WebSocketHandler(producer, redisClient),
};

redisClient.on('error', err => log.error('Redis Client Error', err));

/**
 * Load a subscription's config, Redis-first with a Postgres fallback (P1-10).
 *
 * A flush/eviction of Redis must NOT drop a live subscription: if the key is
 * missing from Redis we read the row from the subscriptions table (source of
 * truth) and re-warm Redis. Only a TRUE not-found (absent in PG too) means
 * the subscription is really gone.
 *
 * @returns {Promise<{ subscription: object|null, found: boolean }>}
 *   found=false means truly deleted (caller should treat as unsubscribe);
 *   subscription=null with found=false on a genuine miss; on a transient PG
 *   error we return found=true + subscription=null so the caller leaves the
 *   existing connection alone rather than tearing it down.
 */
async function loadSubscription(subscriptionId) {
  const cacheKey = subscriptionCacheKey(subscriptionId);
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      try {
        return { subscription: JSON.parse(cached), found: true };
      } catch (err) {
        log.error(`Bad Redis payload for ${subscriptionId}:`, err.message);
        // Fall through to PG — the cache entry is corrupt.
      }
    }
  } catch (err) {
    log.error(`Redis read failed for ${subscriptionId}:`, err.message);
    // Fall through to PG; Redis may be down.
  }

  if (!pgAvailable) {
    // No PG to fall back to — preserve the old behaviour (Redis is the only
    // source) but signal "don't treat as deleted" so we don't tear down a
    // live connection just because Redis blipped.
    return { subscription: null, found: true };
  }

  try {
    const r = await pool.query(
      `SELECT subscription_id, organization_id, connection_type, args,
              webhook_url, webhook_secret
       FROM subscriptions WHERE subscription_id = $1`,
      [subscriptionId]
    );
    if (r.rowCount === 0) {
      // Truly gone — not in Redis, not in PG.
      return { subscription: null, found: false };
    }
    const row = r.rows[0];
    // args is jsonb in PG → already an object; normalize just in case a
    // legacy row stored it as text.
    if (typeof row.args === 'string') {
      try {
        row.args = JSON.parse(row.args);
      } catch {
        row.args = {};
      }
    }
    // Re-warm Redis so subsequent lookups don't pay the PG cost.
    try {
      await redisClient.set(cacheKey, JSON.stringify(row));
      log.info(`Re-warmed Redis from Postgres for subscription ${subscriptionId}`);
    } catch (err) {
      log.error(`Failed to re-warm Redis for ${subscriptionId}:`, err.message);
    }
    return { subscription: row, found: true };
  } catch (err) {
    log.error(`Postgres fallback lookup failed for ${subscriptionId}:`, err.message);
    // Transient PG error — don't treat as deleted.
    return { subscription: null, found: true };
  }
}

function handlerFor(subscription) {
  const handler = connectionHandlers[subscription.connection_type];
  if (!handler) {
    log.error(`No handler found for connection type: ${subscription.connection_type}`);
  }
  return handler;
}

// Reconcile this pod's upstream connections against the partitions it owns.
//
// SCAN MATCH 'sub:*' is critical — Redis is shared with rate-limit
// counters and other state. Without the prefix filter, the connector would
// try to JSON.parse rate-limit values and contact every "subscription" found.
//
// Unlike the old reloadActiveSubscriptions(), this:
//   1. connects ONLY to subscriptions whose partition this pod owns (P1-2),
//   2. disconnects any currently-held connection whose partition we no longer
//      own (so a rebalance hands a sub off cleanly to its new owner),
//   3. caps concurrent (re)connects via pLimit to avoid a reconnect storm,
//   4. uses the Redis→Postgres fallback so a flushed cache doesn't darken us.
async function reconcileOwnedSubscriptions(reason) {
  try {
    // 1. Drop connections we no longer own (post-rebalance hand-off).
    for (const handler of Object.values(connectionHandlers)) {
      for (const id of handler.activeSubscriptionIds()) {
        if (!ownsSubscription(id)) {
          log.info(`Releasing subscription ${id} (no longer owned) [${reason}]`);
          try {
            handler.disconnect(id);
          } catch (err) {
            log.error(`Release disconnect failed for ${id}:`, err.message);
          }
        }
      }
    }

    // 2. Scan the cache for subscriptions we DO own and (re)connect them.
    const cacheKeys = [];
    let cursor = 0;
    do {
      const result = await redisClient.scan(cursor, {
        MATCH: SUBSCRIPTION_KEY_PATTERN,
        COUNT: 100,
      });
      cursor = result.cursor;
      cacheKeys.push(...result.keys);
    } while (cursor !== 0);

    const ownedIds = [];
    for (const key of cacheKeys) {
      const subscriptionId = subscriptionIdFromKey(key);
      if (!subscriptionId) continue;
      if (!ownsSubscription(subscriptionId)) continue;
      ownedIds.push(subscriptionId);
    }

    log.info(
      `Reconcile [${reason}]: ${ownedIds.length} owned subscription(s) across ${ownedPartitions.size} partition(s) (scanned ${cacheKeys.length})`
    );

    // Cap concurrent reconnects so a rebalance/boot doesn't dial everything
    // at once.
    const limit = pLimit(RELOAD_CONCURRENCY);
    await Promise.all(
      ownedIds.map(subscriptionId =>
        limit(async () => {
          const { subscription, found } = await loadSubscription(subscriptionId);
          if (!found) {
            // Disappeared from both Redis and PG between the scan and now —
            // nothing to connect.
            return;
          }
          if (!subscription) return; // transient miss; leave as-is
          const handler = handlerFor(subscription);
          if (!handler) return;
          log.info(`Re-establishing connection for subscription ID: ${subscriptionId}`);
          await handler.connect(subscription);
        })
      )
    );
  } catch (err) {
    log.error(`Error reconciling subscriptions [${reason}]:`, err.message);
  }
}

async function handleMessage({ topic, message }) {
  const subscriptionId = message.value ? message.value.toString() : null;
  if (!subscriptionId) {
    log.error(`Received empty message on topic ${topic}`);
    return;
  }
  // Kafka only delivers partitions this pod owns, so any message we receive
  // here is for a subscription we own — no extra ownership filter needed.
  log.info(`Received message from topic: ${topic} with subscriptionId: ${subscriptionId}`);

  if (topic === 'subscription_events') {
    try {
      const { subscription, found } = await loadSubscription(subscriptionId);
      if (!found) {
        log.error(`Subscription ${subscriptionId} not found in Redis OR Postgres; cannot connect`);
        return;
      }
      if (!subscription) return; // transient miss
      const handler = handlerFor(subscription);
      if (!handler) return;
      await handler.connect(subscription);
    } catch (err) {
      log.error('Error handling subscription_events:', err.message);
    }
    return;
  }

  if (topic === 'update_events') {
    // Subscription config changed — tear down the existing connection
    // and reopen with the new config from Redis (Postgres fallback).
    try {
      const { subscription, found } = await loadSubscription(subscriptionId);
      if (!found) {
        log.error(`Subscription ${subscriptionId} not found for update event; cannot reload`);
        return;
      }
      if (!subscription) return; // transient miss — keep the existing conn
      const handler = handlerFor(subscription);
      if (!handler) return;
      log.info(`Reloading subscription ID: ${subscriptionId} (update event)`);
      handler.disconnect(subscriptionId);
      await handler.connect(subscription);
    } catch (err) {
      log.error('Error processing update event:', err.message);
    }
    return;
  }

  if (topic === 'unsubscribe_events') {
    const cacheKey = subscriptionCacheKey(subscriptionId);
    try {
      // For teardown we look at Redis only — we don't want a PG fallback to
      // resurrect config for a sub we're explicitly tearing down. If Redis
      // has no entry, fall back to closing every handler's connection for
      // this id so we don't leak a socket when the cache was wiped first.
      const subscriptionDetails = await redisClient.get(cacheKey);
      if (subscriptionDetails) {
        const subscription = JSON.parse(subscriptionDetails);
        const handler = connectionHandlers[subscription.connection_type];
        if (handler) {
          handler.disconnect(subscriptionId);
          log.info(
            `Disconnected from ${subscription.connection_type} for subscription ID: ${subscriptionId}`
          );
        } else {
          log.error(`No handler found for connection type: ${subscription.connection_type}`);
        }
      } else {
        log.warn(`Unsubscribe event for ${subscriptionId} but no Redis entry`);
        for (const handler of Object.values(connectionHandlers)) {
          try {
            handler.disconnect(subscriptionId);
          } catch (e) {
            log.error(`Disconnect-by-fallback failed for ${subscriptionId}:`, e.message);
          }
        }
      }
      // Always remove from Redis to keep cache + DB consistent
      await redisClient.del(cacheKey);
    } catch (err) {
      log.error('Error handling unsubscribe_events:', err.message);
    }
  }
}

// Internal HTTP for /metrics + /health on METRICS_PORT (default 9090).
// Used by Prometheus scraping and by the docker-compose healthcheck.
const metricsServer = startMetricsServer({ logger: log });

(async () => {
  try {
    await redisClient.connect();
    log.info('Redis client connected');

    // Probe Postgres so loadSubscription knows whether the fallback is
    // available. Best-effort — the connector still runs off Redis if PG is
    // down; we just lose the flush-resilience until PG recovers.
    try {
      await pool.query('SELECT 1');
      pgAvailable = true;
      log.info('Subscription connector: PostgreSQL connected (Redis-miss fallback enabled)');
    } catch (err) {
      log.error(
        'Subscription connector: PostgreSQL unavailable (Redis-miss fallback disabled):',
        err.message
      );
    }

    await producer.connect();
    await consumer.connect();

    // Learn which partitions we own from the consumer group assignment and
    // (re)build our connection set on every rebalance (P1-2). The first
    // GROUP_JOIN also drives the initial reload — we deliberately DON'T
    // reload at boot before assignment is known, otherwise we'd connect to
    // subscriptions another pod owns.
    consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
      const assignment = (payload && payload.memberAssignment) || {};
      const partitions = assignment[OWNERSHIP_TOPIC] || [];
      ownedPartitions = new Set(partitions);
      ownedPartitionsGauge.set(ownedPartitions.size);
      log.info(
        `GROUP_JOIN: assigned ${ownedPartitions.size}/${KAFKA_PARTITIONS} partition(s) of ${OWNERSHIP_TOPIC}: [${partitions.join(',')}]`
      );
      // Reconcile asynchronously — the GROUP_JOIN handler must return
      // promptly so it doesn't stall the consumer's join flow.
      reconcileOwnedSubscriptions(initialReloadDone ? 'rebalance' : 'initial').catch(err =>
        log.error('Reconcile after GROUP_JOIN failed:', err.message)
      );
      initialReloadDone = true;
    });

    await consumer.subscribe({
      topics: ['subscription_events', 'unsubscribe_events', 'update_events'],
      fromBeginning: false,
    });

    await consumer.run({
      // Manual commit so a process crash mid-handleMessage replays
      // the message on restart instead of losing it (kafkajs's default
      // autoCommit moves the cursor every 5s regardless of handler
      // progress).
      autoCommit: false,
      eachMessage: async payload => {
        try {
          await handleMessage(payload);
          subscriptionEventsHandled.inc({ topic: payload.topic, outcome: 'ok' });
        } catch (err) {
          subscriptionEventsHandled.inc({ topic: payload.topic, outcome: 'error' });
          log.error('Unhandled error in consumer message handler:', err);
        }
        // Commit even on handler error: handleMessage already absorbs
        // its internal failures (Redis miss, bad JSON, missing handler)
        // and returns gracefully. Re-processing on restart wouldn't
        // change the outcome and the partition would lock up. The
        // commit moves the cursor PAST the message we just processed.
        try {
          await consumer.commitOffsets([
            {
              topic: payload.topic,
              partition: payload.partition,
              offset: String(Number(payload.message.offset) + 1),
            },
          ]);
        } catch (err) {
          log.error('Failed to commit Kafka offset:', err.message);
        }
      },
    });

    log.info('Subscription connector ready');
  } catch (err) {
    log.error('Failed to start subscription-connector:', err);
    process.exit(1);
  }
})();

// Graceful shutdown — drain upstream sockets FIRST (P2-17) so sources see a
// clean close, then disconnect Kafka clients, close Redis + PG, then exit.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Subscription connector received ${signal}, shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    log.error('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10000);
  try {
    // Drain upstream connections before tearing down Kafka so the close
    // handshakes complete within the force-exit budget. Each handler bounds
    // its own per-socket wait, so this can't hang past ~that budget.
    await Promise.allSettled(
      Object.values(connectionHandlers).map(h =>
        typeof h.closeAll === 'function' ? h.closeAll() : Promise.resolve()
      )
    );
    await Promise.allSettled([
      new Promise(resolve => metricsServer.close(resolve)),
      consumer.disconnect(),
      producer.disconnect(),
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

// Last-resort safety nets (P2-1). Heavy fire-and-forget usage (handler
// reconnects, producer sends, notification dispatch) means a stray rejection
// or throw shouldn't silently zombie the process — on Node >=22 an
// unhandledRejection terminates by default anyway, so route both through the
// graceful shutdown so upstream sockets + Kafka still drain.
process.on('unhandledRejection', reason => {
  log.error('Unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
  shutdown('unhandledRejection');
});
process.on('uncaughtException', err => {
  log.error('Uncaught exception:', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});
