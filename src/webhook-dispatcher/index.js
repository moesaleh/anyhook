require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const { Kafka, logLevel, CompressionTypes } = require('kafkajs');
const redis = require('@redis/client');
const axios = require('axios');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const promClient = require('prom-client');
const { createLogger } = require('../lib/logger');
const { startMetricsServer } = require('../lib/metrics-server');
const { signRequest } = require('../lib/webhook-signature');
const { subscriptionCacheKey } = require('../lib/subscription-cache');
const { dispatchNotification, pollNotificationAttempts } = require('../lib/notifications');
const { makeEmailTransport } = require('../lib/email');
const { guardedAxiosConfig, SsrfBlockedError } = require('../lib/ssrf-guard');
const { startOutboxDrainer } = require('./outbox-drainer');

const log = createLogger('webhook-dispatcher');

// Service-specific metrics
const webhookDeliveries = new promClient.Counter({
  name: 'webhook_deliveries_total',
  help: 'Total webhook delivery attempts',
  labelNames: ['status'], // success | retrying | failed | dlq
});
const webhookDeliveryDuration = new promClient.Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Webhook HTTP request duration (seconds)',
  labelNames: ['status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});
const pendingRetriesGauge = new promClient.Gauge({
  name: 'webhook_pending_retries',
  help: 'Current size of the pending_retries queue',
});
const outboxPendingGauge = new promClient.Gauge({
  name: 'outbox_pending_total',
  help: 'Outbox rows pending publish to Kafka, grouped by topic',
  labelNames: ['topic'],
});
const notificationAttemptsGauge = new promClient.Gauge({
  name: 'notification_attempts_pending_total',
  help: 'notification_attempts rows pending or in retry, grouped by status',
  labelNames: ['status'],
});
// DLQ backlog (P2-3). dlq_events is a parking topic — events land here when
// the retry ladder is exhausted and wait for an explicit operator redrive
// (redriveDlqEvent), there is no automatic consumer. We can't read Kafka
// consumer-group lag from here cheaply, so we approximate DLQ size with the
// count of delivery_events rows whose terminal status is 'dlq' that have NOT
// since been redriven back into pending_retries. This is the operator-facing
// "stuck in the dead-letter queue" signal an alert can fire on.
const dlqPendingGauge = new promClient.Gauge({
  name: 'dlq_events_pending_total',
  help: 'Events parked in the DLQ (terminal dlq delivery with no pending retry) awaiting operator redrive',
});

function parseBrokers(envValue) {
  return (envValue || 'localhost:9092')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Resolve the Kafka producer compression codec from KAFKA_COMPRESSION
// (P2-15). Accepts gzip / snappy / lz4 / zstd / none (case-insensitive);
// anything unrecognized (or unset) falls back to no compression so the
// default dev stack keeps working without extra native codec deps. The
// resolved value is reused by the outbox drainer and the DLQ producer.
function resolveCompression(envValue) {
  switch (String(envValue || '').toLowerCase()) {
    case 'gzip':
      return CompressionTypes.GZIP;
    case 'snappy':
      return CompressionTypes.Snappy;
    case 'lz4':
      return CompressionTypes.LZ4;
    case 'zstd':
      return CompressionTypes.ZSTD;
    case 'none':
    case '':
      return CompressionTypes.None;
    default:
      log.warn(`Unknown KAFKA_COMPRESSION="${envValue}", falling back to none`);
      return CompressionTypes.None;
  }
}
const KAFKA_COMPRESSION = resolveCompression(process.env.KAFKA_COMPRESSION);

// Initialize Kafka (kafkajs), Redis, and PostgreSQL clients
const kafka = new Kafka({
  clientId: 'webhook-dispatcher',
  brokers: parseBrokers(process.env.KAFKA_HOST),
  logLevel: logLevel.WARN,
});
const consumer = kafka.consumer({ groupId: 'webhook-dispatcher' });
// Durable producer config (P1-8). The outbox drainer publishes events the
// connector consumes; if a produce ack is lost the outbox row stays unsent
// and is retried, so we want the strongest broker durability:
//   - acks: 'all'      — wait for all in-sync replicas (no silent loss on a
//                        leader failover mid-publish).
//   - idempotent: true — broker de-dups producer retries, so an outbox row
//                        retried after a flaky ack can't double-publish.
//                        kafkajs requires maxInFlightRequests <= 5 with
//                        idempotency; we pin it explicitly to be safe across
//                        kafkajs versions.
// allowAutoTopicCreation stays false — topics are pre-created by the
// management service's createKafkaTopics().
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  idempotent: true,
  acks: -1, // 'all'
  maxInFlightRequests: 5,
});
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Internal HTTP for /metrics + /health on METRICS_PORT (default 9090).
const metricsServer = startMetricsServer({ logger: log });

// Email transport for DLQ notifications. Reads SMTP_* env at startup;
// no-op in dev where SMTP_HOST is unset. Slack notifications go via
// axios direct so they don't depend on this transport.
const emailTransport = makeEmailTransport({ log });

// Connect Redis + PG, start the retry poller, then connect Kafka clients.
redisClient.on('error', err => log.error('Redis Client Error', err));
(async () => {
  try {
    await redisClient.connect();
    log.info('Webhook dispatcher: Redis client connected');

    let pgReady = false;
    try {
      await pool.query('SELECT 1');
      log.info('Webhook dispatcher: PostgreSQL connected');
      pgReady = true;
      // Start the persistent retry poller. Crashed/restarted workers leave
      // rows in pending_retries; the next claim cycle picks them up.
      retryPollerHandle = setInterval(pollRetryQueue, RETRY_POLL_INTERVAL_MS);
      // Run one cycle immediately so we don't wait the full interval after start.
      pollRetryQueue();
      log.info(
        `Retry poller started (interval=${RETRY_POLL_INTERVAL_MS}ms, batch=${RETRY_BATCH_SIZE}, worker=${WORKER_ID})`
      );
      // Outbox drainer — extracted into ./outbox-drainer (P2-18). Same
      // FOR UPDATE SKIP LOCKED pattern; runs in-process here. We wire it
      // after the producer is connected (below) so it always has a live
      // producer to publish through.
      // Notification retry poller — picks up email/Slack alerts that
      // failed on first send (transient SMTP outage, Slack 429, etc.)
      // and retries with backoff (1m → 5m → 30m → 2h → DLQ).
      notificationPollerHandle = setInterval(
        () =>
          pollNotificationAttempts({
            pool,
            emailTransport,
            workerId: WORKER_ID,
            batchSize: NOTIFICATION_BATCH_SIZE,
            lockTimeoutMs: NOTIFICATION_LOCK_TIMEOUT_MS,
          }).catch(err => log.error('Notification poll failed:', err.message)),
        NOTIFICATION_POLL_INTERVAL_MS
      );
      log.info(
        `Notification poller started (interval=${NOTIFICATION_POLL_INTERVAL_MS}ms, batch=${NOTIFICATION_BATCH_SIZE})`
      );
    } catch (err) {
      log.error(
        'Webhook dispatcher: PostgreSQL unavailable (retry queue + delivery logging disabled):',
        err.message
      );
    }

    await producer.connect();

    // Start the outbox drainer now that the producer is live (P2-18). Gated
    // on PG being available — with no DB there's nothing to drain.
    if (pgReady) {
      outboxDrainer = startOutboxDrainer({
        pool,
        producer,
        log,
        compression: KAFKA_COMPRESSION,
        intervalMs: OUTBOX_POLL_INTERVAL_MS,
        batchSize: OUTBOX_BATCH_SIZE,
        lockTimeoutMs: OUTBOX_LOCK_TIMEOUT_MS,
        workerId: WORKER_ID,
        outboxPendingGauge,
        notificationAttemptsGauge,
      });
      log.info(
        `Outbox drainer started (interval=${OUTBOX_POLL_INTERVAL_MS}ms, batch=${OUTBOX_BATCH_SIZE})`
      );
    }

    await consumer.connect();
    await consumer.subscribe({ topics: ['connection_events'], fromBeginning: false });
    await consumer.run({
      // Process independent partitions concurrently (P1-3). Without this,
      // kafkajs delivers one partition at a time and a single slow endpoint
      // head-of-line-blocks every partition. Default to the topic's partition
      // count so each partition can make progress in parallel.
      partitionsConsumedConcurrently: KAFKA_PARTITIONS,
      // Manual commit so a crash mid-delivery replays the message on restart.
      // The dispatcher's atomic processed_events idempotency gate
      // (handleConnectionEvent) means a replay won't double-fire the webhook
      // -- the INSERT ... ON CONFLICT DO NOTHING claims the event exactly once.
      autoCommit: false,
      // eachBatchAutoResolve:false is REQUIRED for the safe-prefix commit to
      // mean anything. With the default (true), kafkajs auto-resolves the
      // ENTIRE batch's offsets when the handler returns — including offsets we
      // deliberately left unresolved because of a gap. Turning it off means
      // only our explicit resolveOffset() calls advance the committed position.
      eachBatchAutoResolve: false,
      // eachBatch (was eachMessage): lets us fan out the outbound POSTs within
      // a partition's batch through a bounded concurrency pool instead of
      // awaiting them one-at-a-time. Offsets are committed via resolveOffset +
      // commitOffsetsIfNecessary, which only advances the committed position
      // over a CONTIGUOUS prefix of handled offsets -- so a crash replays from
      // the first unhandled message and we never commit past a gap.
      eachBatch: async batchPayload => {
        await handleConnectionBatch(batchPayload);
      },
    });
    log.info('Webhook dispatcher ready');
  } catch (err) {
    log.error('Failed to start webhook-dispatcher:', err);
    process.exit(1);
  }
})();

// Retry intervals: 15 mins, 1 hour, 2 hours, 6 hours, 12 hours, 24 hours (in minutes)
const retryIntervals = [15, 60, 120, 360, 720, 1440];
const maxRetries = retryIntervals.length;
const MAX_BODY_SIZE = 10240; // 10KB max for stored request/response bodies

// Delivery concurrency / timeout (P1-3).
//   KAFKA_PARTITIONS              — how many connection_events partitions the
//                                   consumer reads in parallel
//                                   (partitionsConsumedConcurrently). Mirror
//                                   the topic's partition count (default 8).
//   WEBHOOK_DELIVERY_CONCURRENCY  — max in-flight outbound POSTs per consumed
//                                   batch (the inline pLimit pool). Bounds the
//                                   fan-out so a fat batch can't open hundreds
//                                   of sockets at once.
//   WEBHOOK_TIMEOUT_MS            — per-request axios timeout. Cut from the old
//                                   30s so a dead endpoint fails fast into the
//                                   retry queue instead of holding a slot.
const KAFKA_PARTITIONS = parseInt(process.env.KAFKA_PARTITIONS, 10) || 8;
const WEBHOOK_DELIVERY_CONCURRENCY = parseInt(process.env.WEBHOOK_DELIVERY_CONCURRENCY, 10) || 16;
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS, 10) || 8000;

/**
 * Tiny bounded-concurrency pool (no new dependency — replaces `p-limit`).
 *
 * Returns a function `run(fn)` that invokes `fn` immediately if fewer than
 * `concurrency` tasks are active, otherwise queues it until a slot frees.
 * Resolves/rejects with `fn`'s result. We never reject the slot itself — the
 * caller is responsible for catching inside `fn` — so one failed task can't
 * wedge the queue.
 */
function pLimit(concurrency) {
  const max = Math.max(1, concurrency | 0);
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// Persistent retry queue (pending_retries table). Replaces the old in-process
// setTimeout model — retries now survive restarts and can be sharded across
// multiple dispatcher pods via SELECT ... FOR UPDATE SKIP LOCKED.
const RETRY_POLL_INTERVAL_MS = parseInt(process.env.RETRY_POLL_INTERVAL_MS, 10) || 30 * 1000;
const RETRY_BATCH_SIZE = parseInt(process.env.RETRY_BATCH_SIZE, 10) || 25;
const RETRY_LOCK_TIMEOUT_MS = parseInt(process.env.RETRY_LOCK_TIMEOUT_MS, 10) || 5 * 60 * 1000;
const WORKER_ID = `${require('os').hostname()}-${process.pid}`;
let retryPollerHandle = null;

// Outbox drainer (outbox_events table). The /subscribe + /unsubscribe +
// PUT /subscriptions + bulk + admin-wipe endpoints write Kafka publishes
// into the outbox inside their DB transaction; this worker drains the
// outbox to Kafka. Crash mid-publish leaves the row locked_at-stale;
// the next sweep reclaims via the lock-timeout — same pattern as
// pending_retries.
const OUTBOX_POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS, 10) || 1000;
const OUTBOX_BATCH_SIZE = parseInt(process.env.OUTBOX_BATCH_SIZE, 10) || 50;
const OUTBOX_LOCK_TIMEOUT_MS = parseInt(process.env.OUTBOX_LOCK_TIMEOUT_MS, 10) || 60 * 1000;
// Handle returned by startOutboxDrainer ({ stop, pollOnce }); null until the
// drainer is wired in the bootstrap IIFE.
let outboxDrainer = null;

// Notification retry poller — drains notification_attempts rows whose
// previous send failed but max_attempts hasn't been hit. Same FOR
// UPDATE SKIP LOCKED + stale-lock pattern.
const NOTIFICATION_POLL_INTERVAL_MS =
  parseInt(process.env.NOTIFICATION_POLL_INTERVAL_MS, 10) || 60 * 1000;
const NOTIFICATION_BATCH_SIZE = parseInt(process.env.NOTIFICATION_BATCH_SIZE, 10) || 25;
const NOTIFICATION_LOCK_TIMEOUT_MS =
  parseInt(process.env.NOTIFICATION_LOCK_TIMEOUT_MS, 10) || 5 * 60 * 1000;
let notificationPollerHandle = null;

/**
 * Truncate a value to a max string length for storage.
 * Handles objects, strings, and nulls.
 */
function truncateBody(value, maxLen = MAX_BODY_SIZE) {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...[truncated]';
}

/**
 * Record a delivery event to PostgreSQL.
 * Best-effort: if the database is unavailable, log and continue.
 * The dispatcher must never fail to deliver because of logging.
 */
async function recordDelivery({
  subscriptionId,
  organizationId,
  eventId,
  status,
  httpStatusCode = null,
  responseTimeMs = null,
  payloadSizeBytes = null,
  requestBody = null,
  responseBody = null,
  retryCount = 0,
  errorMessage = null,
}) {
  try {
    await pool.query(
      `INSERT INTO delivery_events
             (subscription_id, organization_id, event_id, status, http_status_code,
              response_time_ms, payload_size_bytes, request_body, response_body,
              retry_count, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        subscriptionId,
        organizationId,
        eventId,
        status,
        httpStatusCode,
        responseTimeMs,
        payloadSizeBytes,
        truncateBody(requestBody),
        truncateBody(responseBody),
        retryCount,
        errorMessage,
      ]
    );
  } catch (err) {
    // Best-effort: log the failure but don't crash
    log.error(`Failed to record delivery event for ${subscriptionId}:`, err.message);
  }
}

/**
 * Atomic idempotency gate (P1-4).
 *
 * Claims (subscription, event) by inserting one row into processed_events:
 *
 *     INSERT INTO processed_events (...) VALUES (...) ON CONFLICT DO NOTHING
 *     RETURNING 1;
 *
 * The PRIMARY KEY (subscription_id, event_id) makes the insert-or-skip atomic,
 * so under a Kafka rebalance double-delivery (or two pods racing the same
 * event) EXACTLY ONE caller gets a returned row and proceeds; the loser sees
 * rowCount === 0 and skips. This replaces the old SELECT-then-act dedup, which
 * had a check-then-act race that could double-fire the endpoint.
 *
 * Returns:
 *   true  — we won the claim, proceed with delivery.
 *   false — already processed by someone else, skip.
 *
 * On a PG error we return true (fail open): we'd rather risk a duplicate
 * delivery than silently drop a legitimate event when the DB is flaky. Events
 * with no producer-supplied id (legacy in-flight messages) also can't be
 * deduped — they get a fresh uuid and always proceed.
 *
 * @param {string} subscriptionId
 * @param {string} eventId
 * @param {boolean} hasProducerEventId  whether the id came from the producer
 *                                       (only then is dedup meaningful)
 * @param {string|null} organizationId  denormalized for retention; NOT part of
 *                                       the dedup key, may be null
 */
async function claimEvent(subscriptionId, eventId, hasProducerEventId, organizationId = null) {
  if (!hasProducerEventId) return true; // no stable id → nothing to dedup against
  try {
    const res = await pool.query(
      `INSERT INTO processed_events (subscription_id, event_id, organization_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING 1`,
      [subscriptionId, eventId, organizationId]
    );
    if (res.rowCount === 0) {
      log.debug(`Skipping duplicate delivery for subscription=${subscriptionId} event=${eventId}`);
      return false;
    }
    return true;
  } catch (err) {
    // PG unavailable / FK miss — fall through; we'd rather risk a duplicate
    // delivery than drop the legitimate event.
    log.error('Idempotency claim failed (proceeding):', err.message);
    return true;
  }
}

// Handle a single message from 'connection_events'.
async function handleConnectionEvent({ message }) {
  const raw = message.value ? message.value.toString() : null;
  if (!raw) {
    log.error('Received empty message on connection_events, skipping');
    return;
  }

  let subscriptionId, data, payloadEventId;
  try {
    ({ subscriptionId, eventId: payloadEventId, data } = JSON.parse(raw));
  } catch (err) {
    log.error('Failed to parse Kafka message, skipping:', err.message);
    return;
  }

  if (!subscriptionId) {
    log.error('Missing subscriptionId in Kafka message, skipping');
    return;
  }

  // Use the producer-supplied event_id when present so a Kafka redelivery
  // (rebalance / pod restart before commit) reuses the same id and the
  // atomic processed_events gate below skips the redelivered message.
  // Older in-flight messages without eventId fall back to a fresh uuid.
  const eventId = payloadEventId || uuidv4();

  try {
    // Resolve the live subscription first (Redis hot cache). This read is
    // idempotent, so a racing redelivery doing the same read is harmless —
    // the actual dedup is the atomic processed_events claim below, which only
    // one of the racers can win. Resolving first also means we never burn the
    // event's idempotency marker on a transient "subscription not cached yet"
    // miss: a later redelivery can still succeed once Redis is repopulated.
    const subscriptionDetails = await redisClient.get(subscriptionCacheKey(subscriptionId));

    if (!subscriptionDetails) {
      log.error(`No subscription details found for ID: ${subscriptionId}`);
      return;
    }

    const subscription = JSON.parse(subscriptionDetails);
    const {
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
      organization_id: organizationId,
    } = subscription;

    if (!organizationId) {
      log.error(`Subscription ${subscriptionId} has no organization_id; cannot record delivery`);
      return;
    }

    // Atomic idempotency gate — exactly one racer proceeds past this point.
    const claimed = await claimEvent(
      subscriptionId,
      eventId,
      Boolean(payloadEventId),
      organizationId
    );
    if (!claimed) return;

    try {
      await sendWebhook(
        subscriptionId,
        organizationId,
        webhookUrl,
        webhookSecret,
        data,
        eventId,
        0
      );
    } catch (error) {
      if (error.ssrfBlocked) {
        // Hard, non-retryable: the target is (now) a blocked address. The
        // terminal 'dlq' delivery_events row was already written in
        // sendWebhook; park it in the DLQ for operator visibility rather than
        // burning the retry ladder against a destination we'll never reach.
        await sendToDLQ(subscriptionId, organizationId, webhookUrl, data, eventId);
        return;
      }
      log.error(
        `Initial webhook request failed for subscription ID: ${subscriptionId}`,
        error.message
      );
      // Enqueue for the persistent poller instead of using setTimeout. The
      // poller will pick it up at next_attempt_at and re-fire via processClaimedRetry.
      await enqueueRetry(eventId, subscriptionId, organizationId, JSON.stringify({ data }), 0);
    }
  } catch (error) {
    log.error(`Error processing message for subscription ID: ${subscriptionId}`, error);
  }
}

/**
 * eachBatch handler for connection_events (P1-3).
 *
 * Fans the batch's messages out through a bounded concurrency pool so N
 * outbound POSTs proceed in parallel instead of one-at-a-time, then commits
 * offsets SAFELY:
 *
 *   - Each message is processed via handleConnectionEvent (which never throws
 *     — it catches internally — and either delivers or enqueues a retry, so a
 *     settled task means "fully handled, safe to commit past").
 *   - We track which offsets finished, then resolveOffset() them in ascending
 *     order, STOPPING at the first offset that didn't finish. kafkajs commits
 *     only the contiguous resolved prefix, so a crash replays from the first
 *     unhandled message and we never commit across a gap.
 *
 * heartbeat() is called between resolves so a large/slow batch doesn't trip
 * the session timeout, and isRunning()/isStale() short-circuit on rebalance.
 */
async function handleConnectionBatch({
  batch,
  resolveOffset,
  heartbeat,
  isRunning,
  isStale,
  commitOffsetsIfNecessary,
}) {
  const limit = pLimit(WEBHOOK_DELIVERY_CONCURRENCY);
  const handled = new Set();

  await Promise.all(
    batch.messages.map(message =>
      limit(async () => {
        // Stop touching messages that are no longer ours (rebalance) or stale.
        if (!isRunning() || isStale()) return;
        try {
          await handleConnectionEvent({ message });
          handled.add(message.offset);
        } catch (err) {
          // handleConnectionEvent already catches its own errors; this is a
          // last-resort guard so one bad message doesn't reject the batch.
          // Leaving the offset OUT of `handled` means we won't commit past it.
          log.error('Unhandled error in connection_events handler:', err.message);
        }
      })
    )
  );

  // Commit the longest contiguous prefix of fully-handled offsets. Messages in
  // a kafkajs batch are already in ascending offset order.
  for (const message of batch.messages) {
    if (!handled.has(message.offset)) break; // gap → stop; replay from here
    resolveOffset(message.offset);
    await heartbeat();
  }
  await commitOffsetsIfNecessary();
}

/**
 * Send a webhook POST and record the outcome.
 * @param {string} subscriptionId - The subscription UUID
 * @param {string} organizationId - The owning organization UUID (for delivery_events FK)
 * @param {string} webhookUrl - The destination URL
 * @param {string} webhookSecret - HMAC secret for signing
 * @param {any} data - The payload from the source
 * @param {string} eventId - Groups this attempt with retries
 * @param {number} retryCount - 0 for first attempt, 1+ for retries
 */
async function sendWebhook(
  subscriptionId,
  organizationId,
  webhookUrl,
  webhookSecret,
  data,
  eventId,
  retryCount
) {
  const requestBody = JSON.stringify({ data });
  const payloadSizeBytes = Buffer.byteLength(requestBody, 'utf8');
  const startTime = Date.now();

  // Build signature headers. If the secret is missing (e.g. a row predating
  // the migration that somehow escaped backfill), skip signing rather than
  // crash — the receiver will see no X-AnyHook-Signature and can refuse.
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'AnyHook-Webhook/1.0',
    'X-AnyHook-Subscription-Id': subscriptionId,
    'X-AnyHook-Event-Id': eventId,
    'X-AnyHook-Delivery-Attempt': String(retryCount + 1),
  };
  if (webhookSecret) {
    const timestampSec = Math.floor(Date.now() / 1000);
    const { signature } = signRequest(webhookSecret, timestampSec, requestBody);
    headers['X-AnyHook-Timestamp'] = String(timestampSec);
    headers['X-AnyHook-Signature'] = signature;
  } else {
    log.warn(`No webhook_secret for subscription ${subscriptionId}; sending UNSIGNED`);
  }

  // Send-time SSRF defense (P0-4). Create-time URL validation can be defeated
  // by DNS rebinding (a public hostname re-pointed at 169.254.169.254 / an
  // RFC1918 host after the subscription was created). guardedAxiosConfig
  // resolves the hostname NOW, rejects if any resolved address is
  // private/loopback/link-local/CGNAT/IMDS, PINS the socket to the vetted IP,
  // and forces maxRedirects:0 so axios can't be bounced (302 -> IMDS) past the
  // pin. A block here is a HARD, non-retryable failure: record it terminally
  // and throw an error tagged `.ssrfBlocked` so the caller routes straight to
  // the DLQ instead of enqueuing infinite retries against a destination we
  // will never be allowed to reach.
  let axiosConfig;
  try {
    axiosConfig = await guardedAxiosConfig(webhookUrl, {
      timeout: WEBHOOK_TIMEOUT_MS,
      headers,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      const responseTimeMs = Date.now() - startTime;
      log.warn(
        `Webhook BLOCKED by SSRF guard for subscription ${subscriptionId} (reason=${err.reason}); failing into DLQ`
      );
      webhookDeliveries.inc({ status: 'dlq' });
      webhookDeliveryDuration.observe({ status: 'dlq' }, responseTimeMs / 1000);
      await recordDelivery({
        subscriptionId,
        organizationId,
        eventId,
        status: 'dlq',
        responseTimeMs,
        payloadSizeBytes,
        requestBody,
        retryCount,
        errorMessage: `SSRF guard blocked target (${err.reason})`,
      });
      const blocked = new Error(
        `Webhook blocked by SSRF guard for subscription ID: ${subscriptionId}: ${err.reason}`
      );
      blocked.ssrfBlocked = true;
      throw blocked;
    }
    throw err;
  }

  try {
    // Pass the pre-serialized body so the HMAC matches exactly what the
    // receiver hashes. axios would otherwise re-serialize the object. The
    // SSRF-guarded config pins the connection + bans redirects.
    const response = await axios.post(webhookUrl, requestBody, axiosConfig);
    const responseTimeMs = Date.now() - startTime;

    log.debug(
      `Webhook sent successfully for subscription ID: ${subscriptionId} (${responseTimeMs}ms)`
    );

    webhookDeliveries.inc({ status: 'success' });
    webhookDeliveryDuration.observe({ status: 'success' }, responseTimeMs / 1000);

    // Record successful delivery
    await recordDelivery({
      subscriptionId,
      organizationId,
      eventId,
      status: 'success',
      httpStatusCode: response.status,
      responseTimeMs,
      payloadSizeBytes,
      requestBody,
      responseBody:
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
      retryCount,
    });
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const httpStatusCode = error.response?.status || null;
    const responseBody = error.response?.data
      ? typeof error.response.data === 'string'
        ? error.response.data
        : JSON.stringify(error.response.data)
      : null;

    // Status semantics:
    //   'retrying' — failure, more attempts queued.
    //   'dlq'      — final failure on the last allowed attempt; the
    //                caller (processClaimedRetry / handleConnectionEvent)
    //                will publish to the DLQ Kafka topic next, but the
    //                delivery_events row is written HERE with the actual
    //                HTTP status / response body so dashboards have the
    //                terminal context. sendToDLQ() does NOT write a
    //                separate delivery_events row to avoid duplicating
    //                the final attempt.
    //   'failed'   — reserved for processClaimedRetry's
    //                "subscription deleted between schedule and retry"
    //                branch; never emitted from this function.
    const deliveryStatus = retryCount < maxRetries ? 'retrying' : 'dlq';
    webhookDeliveries.inc({ status: deliveryStatus });
    webhookDeliveryDuration.observe({ status: deliveryStatus }, responseTimeMs / 1000);

    // Record the failed attempt
    await recordDelivery({
      subscriptionId,
      organizationId,
      eventId,
      status: deliveryStatus,
      httpStatusCode,
      responseTimeMs,
      payloadSizeBytes,
      requestBody,
      responseBody,
      retryCount,
      errorMessage: error.message,
    });

    throw new Error(
      `Webhook request failed for subscription ID: ${subscriptionId}: ${error.message}`
    );
  }
}

/**
 * Persistent retry queue.
 *
 * Schedule the next retry attempt by inserting/updating a row in
 * pending_retries with next_attempt_at = now + intervals[retryCount].
 * The poller (pollRetryQueue) picks it up when due.
 *
 * @param {string} eventId         - Groups the original delivery + all retries
 * @param {string} subscriptionId  - Owning subscription
 * @param {string} organizationId  - Owning org
 * @param {string} requestBody     - Pre-serialized JSON `{"data": ...}`
 * @param {number} retryCount      - Attempt that just failed; we schedule +1
 */
async function enqueueRetry(eventId, subscriptionId, organizationId, requestBody, retryCount) {
  if (retryCount >= maxRetries) {
    // Already past the last retry — caller should send to DLQ instead.
    return;
  }
  const delayMs = retryIntervals[retryCount] * 60 * 1000;
  const nextAttemptAt = new Date(Date.now() + delayMs);

  try {
    // Use GREATEST(existing, EXCLUDED) on retry_count + next_attempt_at
    // so a duplicate enqueue at a stale (lower) retry count can't
    // reset progress. Without this, a Kafka redelivery (or any other
    // path that re-enqueues the same event_id) would clobber the
    // current retry_count back to a lower value and bury a permanently-
    // failing event in extra retries.
    await pool.query(
      `INSERT INTO pending_retries
         (event_id, subscription_id, organization_id, request_body,
          retry_count, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO UPDATE SET
          retry_count = GREATEST(pending_retries.retry_count, EXCLUDED.retry_count),
          next_attempt_at = GREATEST(pending_retries.next_attempt_at, EXCLUDED.next_attempt_at),
          locked_at = NULL,
          locked_by = NULL`,
      [eventId, subscriptionId, organizationId, requestBody, retryCount, nextAttemptAt]
    );
    // Per-event, fires on every failed attempt — debug, not info (P2-6).
    log.debug(
      `Enqueued retry for event ${eventId} attempt ${retryCount + 1}/${maxRetries} at ${nextAttemptAt.toISOString()}`
    );
  } catch (err) {
    log.error(`Failed to enqueue retry for event ${eventId}:`, err.message);
  }
}

/**
 * Claim a batch of due retries atomically.
 *
 * Single SQL statement does three things:
 *   1. Releases stale locks (worker crashed mid-retry).
 *   2. Selects up to RETRY_BATCH_SIZE due+unlocked rows with FOR UPDATE
 *      SKIP LOCKED — multiple dispatcher pods can poll concurrently
 *      without claiming the same row.
 *   3. Marks the claimed rows with locked_at = NOW() and locked_by = us.
 *
 * Returns the claimed rows.
 */
async function claimDueRetries() {
  // Stale-lock sweep — fire and forget; if it fails we still try to claim.
  pool
    .query(
      `UPDATE pending_retries
       SET locked_at = NULL, locked_by = NULL
       WHERE locked_at IS NOT NULL
         AND locked_at < NOW() - ($1::text || ' milliseconds')::interval`,
      [String(RETRY_LOCK_TIMEOUT_MS)]
    )
    .catch(err => log.error('Stale-lock sweep failed:', err.message));

  const result = await pool.query(
    `WITH due AS (
        SELECT event_id FROM pending_retries
        WHERE locked_at IS NULL AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE pending_retries pr
     SET locked_at = NOW(), locked_by = $2
     FROM due
     WHERE pr.event_id = due.event_id
     RETURNING pr.*`,
    [RETRY_BATCH_SIZE, WORKER_ID]
  );
  return result.rows;
}

/**
 * Process a single claimed retry row: look up the live subscription, fire
 * the webhook, and update or remove the queue row based on outcome.
 */
async function processClaimedRetry(row) {
  let subscription = null;

  // Look up the subscription. Try Redis first (hot cache), then fall
  // back to Postgres if Redis is missing the row — covers the case
  // where an operator flushed Redis between schedule and retry, or a
  // /redis/reload cycle hadn't repopulated the key yet. Without the
  // PG fallback, every in-flight retry would silently DLQ the moment
  // Redis was touched.
  const subscriptionDetails = await redisClient.get(subscriptionCacheKey(row.subscription_id));
  if (subscriptionDetails) {
    try {
      subscription = JSON.parse(subscriptionDetails);
    } catch (err) {
      log.error(`Bad Redis payload for ${row.subscription_id}:`, err.message);
      // Don't drop the queue row — the Redis state may recover. Just unlock.
      await pool.query(
        'UPDATE pending_retries SET locked_at = NULL, locked_by = NULL WHERE event_id = $1',
        [row.event_id]
      );
      return;
    }
  } else {
    try {
      const r = await pool.query(
        `SELECT subscription_id, organization_id, webhook_url, webhook_secret
         FROM subscriptions WHERE subscription_id = $1`,
        [row.subscription_id]
      );
      if (r.rowCount > 0) {
        subscription = r.rows[0];
        // Re-warm the cache so subsequent retries don't pay the PG cost.
        try {
          await redisClient.set(
            subscriptionCacheKey(row.subscription_id),
            JSON.stringify(subscription)
          );
        } catch (err) {
          log.error(`Failed to re-warm Redis for ${row.subscription_id}:`, err.message);
        }
      }
    } catch (err) {
      log.error(`PG fallback lookup failed for ${row.subscription_id}:`, err.message);
      // Unlock so the next poll retries. PG may recover.
      await pool.query(
        'UPDATE pending_retries SET locked_at = NULL, locked_by = NULL WHERE event_id = $1',
        [row.event_id]
      );
      return;
    }
  }

  // Subscription truly deleted (not in Redis, not in PG) — drop the
  // queue row + record a 'failed' delivery_event for audit. The FK
  // CASCADE on sub deletion would normally handle this; this branch
  // covers a race window between sub-delete and the retry poller.
  if (!subscription) {
    log.warn(
      `Subscription ${row.subscription_id} not in Redis OR Postgres; dropping retry ${row.event_id}`
    );
    await pool.query('DELETE FROM pending_retries WHERE event_id = $1', [row.event_id]);
    await recordDelivery({
      subscriptionId: row.subscription_id,
      organizationId: row.organization_id,
      eventId: row.event_id,
      status: 'failed',
      retryCount: row.retry_count,
      errorMessage: 'Subscription deleted before retry could complete',
      requestBody: row.request_body,
    });
    // Fire a 'failed' notification — distinct from DLQ. Operators
    // who only want delivery-policy-exhausted alerts (DLQ) can leave
    // the 'failed' event off their notification_preferences.
    dispatchNotification({
      pool,
      emailTransport,
      organizationId: row.organization_id,
      eventName: 'failed',
      payload: {
        subscriptionId: row.subscription_id,
        webhookUrl: '(subscription deleted)',
        eventId: row.event_id,
      },
    }).catch(err => log.error('failed-event notification dispatch threw:', err.message));
    return;
  }

  const { webhook_url: webhookUrl, webhook_secret: webhookSecret } = subscription;

  let data;
  try {
    data = JSON.parse(row.request_body).data;
  } catch (err) {
    log.error(`Cannot parse request_body for event ${row.event_id} (truncated?):`, err.message);
    // Truncation can't be undone — DLQ this and remove from queue.
    await pool.query('DELETE FROM pending_retries WHERE event_id = $1', [row.event_id]);
    await sendToDLQ(row.subscription_id, row.organization_id, webhookUrl, null, row.event_id);
    return;
  }

  const nextAttempt = row.retry_count + 1;
  try {
    await sendWebhook(
      row.subscription_id,
      row.organization_id,
      webhookUrl,
      webhookSecret,
      data,
      row.event_id,
      nextAttempt
    );
    // Success — drop the queue row.
    await pool.query('DELETE FROM pending_retries WHERE event_id = $1', [row.event_id]);
  } catch (error) {
    // sendWebhook already wrote a delivery_events row with status='retrying'
    // or 'dlq' depending on whether more retries remain.
    if (error.ssrfBlocked) {
      // Hard, non-retryable (P0-4): the target now resolves to a blocked
      // address. Terminal 'dlq' row already written in sendWebhook — park it
      // and drop the queue row instead of scheduling more doomed attempts.
      await sendToDLQ(row.subscription_id, row.organization_id, webhookUrl, data, row.event_id);
      await pool.query('DELETE FROM pending_retries WHERE event_id = $1', [row.event_id]);
    } else if (nextAttempt >= maxRetries) {
      await sendToDLQ(row.subscription_id, row.organization_id, webhookUrl, data, row.event_id);
      await pool.query('DELETE FROM pending_retries WHERE event_id = $1', [row.event_id]);
    } else {
      // Re-schedule with the next backoff and clear the lock.
      await enqueueRetry(
        row.event_id,
        row.subscription_id,
        row.organization_id,
        row.request_body,
        nextAttempt
      );
    }
  }
}

/**
 * Poll loop: claim a batch of due retries and process them. Runs every
 * RETRY_POLL_INTERVAL_MS via setInterval. Errors in one cycle don't stop
 * the next.
 */
async function pollRetryQueue() {
  // Update queue-depth gauge first; cheap and runs every interval. Single
  // SELECT, no FOR UPDATE — eventual consistency is fine for the metric.
  pool
    .query('SELECT COUNT(*)::int AS n FROM pending_retries')
    .then(r => pendingRetriesGauge.set(r.rows[0].n))
    .catch(() => {});

  // DLQ backlog gauge (P2-3): events whose terminal delivery was 'dlq' and
  // which are NOT currently back in pending_retries (i.e. parked, awaiting an
  // explicit operator redrive). Distinct event_ids so multiple dlq attempt
  // rows for one event count once. Eventual consistency is fine for a metric.
  pool
    .query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT DISTINCT de.event_id
         FROM delivery_events de
         WHERE de.status = 'dlq'
           AND NOT EXISTS (
             SELECT 1 FROM pending_retries pr WHERE pr.event_id = de.event_id
           )
       ) parked`
    )
    .then(r => dlqPendingGauge.set(r.rows[0].n))
    .catch(() => {});

  let claimed;
  try {
    claimed = await claimDueRetries();
  } catch (err) {
    log.error('Failed to claim retries:', err.message);
    return;
  }
  if (claimed.length === 0) return;

  log.info(`Processing ${claimed.length} due retries (worker ${WORKER_ID})`);
  for (const row of claimed) {
    try {
      await processClaimedRetry(row);
    } catch (err) {
      log.error(`Retry processing failed for event ${row.event_id}:`, err.message);
      // Unlock so the next poll cycle can pick it up.
      await pool
        .query(
          'UPDATE pending_retries SET locked_at = NULL, locked_by = NULL WHERE event_id = $1',
          [row.event_id]
        )
        .catch(() => {});
    }
  }
}

/**
 * Send failed delivery to the Dead Letter Queue after all retries exhausted.
 *
 * The corresponding delivery_events row was already written by sendWebhook
 * with status='dlq' and the actual HTTP status / response body. We do
 * NOT write another row here — that double-record was the source of
 * inflated 'failed + dlq' totals on dashboards.
 */
async function sendToDLQ(subscriptionId, organizationId, webhookUrl, data, eventId) {
  try {
    await producer.send({
      topic: 'dlq_events',
      messages: [
        {
          key: subscriptionId,
          value: JSON.stringify({ subscriptionId, organizationId, webhookUrl, data, eventId }),
        },
      ],
    });
    log.info(`Message sent to Dead Letter Queue (DLQ) for subscription ID: ${subscriptionId}`);
  } catch (err) {
    log.error('Error sending to Dead Letter Queue (DLQ)', err);
  }
  // Out-of-band notifications (email / Slack) for any prefs the org
  // has registered. Best-effort — failures are logged inside the
  // dispatcher and don't propagate.
  dispatchNotification({
    pool,
    emailTransport,
    organizationId,
    eventName: 'dlq',
    payload: { subscriptionId, webhookUrl, eventId },
  }).catch(err => {
    log.error('Notification dispatch threw:', err.message);
  });
}

/**
 * Close the DLQ loop (P2-3) — re-enqueue a parked dlq_events payload back into
 * pending_retries so the normal retry poller fires it again.
 *
 * dlq_events is a PARKING topic: events land there once the retry ladder is
 * exhausted (or a hard SSRF block) and wait for an explicit operator decision
 * — there is no automatic consumer. This function is the operator's redrive
 * primitive (call it from an admin worker / one-shot script / future endpoint
 * after the operator has, e.g., fixed the destination URL).
 *
 * It resets retry_count to 0 so the event gets a fresh ladder, and clears any
 * stale lock. We deliberately do NOT bypass the SSRF guard or any other
 * delivery check — a redriven event re-runs sendWebhook exactly like a first
 * delivery, so a still-blocked target will simply DLQ again.
 *
 * @param {object} message  a dlq_events payload: the JSON object that was
 *                          produced by sendToDLQ, i.e.
 *                          { subscriptionId, organizationId, webhookUrl, data, eventId }
 * @returns {Promise<boolean>} true if a pending_retries row was (re)written.
 */
async function redriveDlqEvent(message) {
  const { subscriptionId, organizationId, eventId, data } = message || {};
  if (!subscriptionId || !eventId) {
    log.error('redriveDlqEvent: message missing subscriptionId/eventId, skipping');
    return false;
  }

  // Rebuild the stored request_body shape sendWebhook/processClaimedRetry
  // expect (`{"data": ...}`). `data` may be absent (e.g. a row DLQ'd after a
  // request_body truncation) — re-enqueue with empty data so the poller at
  // least re-attempts against the live subscription.
  const requestBody = JSON.stringify({ data: data ?? null });
  const nextAttemptAt = new Date(); // due immediately

  try {
    await pool.query(
      `INSERT INTO pending_retries
         (event_id, subscription_id, organization_id, request_body,
          retry_count, next_attempt_at, locked_at, locked_by)
       VALUES ($1, $2, $3, $4, 0, $5, NULL, NULL)
       ON CONFLICT (event_id) DO UPDATE SET
          subscription_id = EXCLUDED.subscription_id,
          organization_id = EXCLUDED.organization_id,
          request_body = EXCLUDED.request_body,
          retry_count = 0,
          next_attempt_at = EXCLUDED.next_attempt_at,
          locked_at = NULL,
          locked_by = NULL`,
      [eventId, subscriptionId, organizationId || null, requestBody, nextAttemptAt]
    );
    log.info(
      `Redrove DLQ event ${eventId} for subscription ${subscriptionId} back into pending_retries`
    );
    return true;
  } catch (err) {
    log.error(`Failed to redrive DLQ event ${eventId}:`, err.message);
    return false;
  }
}

// Graceful shutdown — stop the retry poller, disconnect kafkajs clients,
// close Redis + PG, exit. Stopping the poller first means in-flight retries
// finish; new ones won't be claimed. Idempotent: a signal racing an
// uncaughtException-triggered shutdown won't double-disconnect or double-exit.
let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Webhook dispatcher received ${signal}, shutting down gracefully...`);
  if (retryPollerHandle) {
    clearInterval(retryPollerHandle);
    retryPollerHandle = null;
  }
  if (outboxDrainer) {
    outboxDrainer.stop();
    outboxDrainer = null;
  }
  if (notificationPollerHandle) {
    clearInterval(notificationPollerHandle);
    notificationPollerHandle = null;
  }
  const forceExit = setTimeout(() => {
    log.error('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10000);
  try {
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
    process.exit(exitCode);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Process-level safety nets (P2-1). The dispatcher does a lot of fire-and-
// forget work (notification dispatch, gauge refreshes, stale-lock sweeps); a
// rejected promise that escapes one of those must NOT silently terminate the
// process on Node >=22 (unhandledRejection is fatal by default there).
//   - unhandledRejection: log and keep running. These are almost always a
//     best-effort side-channel; crashing the whole delivery pipeline over one
//     is worse than the leak.
//   - uncaughtException: the process is in an unknown state — log and run the
//     orderly shutdown so we drain/close cleanly, then exit non-zero so the
//     orchestrator restarts us.
process.on('unhandledRejection', reason => {
  log.error(
    'Unhandled promise rejection (continuing):',
    reason instanceof Error ? reason.message : reason
  );
});
process.on('uncaughtException', err => {
  log.error('Uncaught exception, shutting down:', err);
  shutdown('uncaughtException', 1);
});

// Exported for the Wave-3 test suite. The runtime wiring above (bootstrap
// IIFE + signal handlers) stays intact; tests drive these pure-ish functions
// directly against mocked pg/redis/axios/producer. The outbox drainer's
// claim/deliver step lives in ./outbox-drainer and is exported there.
module.exports = {
  handleConnectionEvent,
  handleConnectionBatch,
  sendWebhook,
  enqueueRetry,
  processClaimedRetry,
  claimDueRetries,
  claimEvent,
  recordDelivery,
  sendToDLQ,
  redriveDlqEvent,
  pLimit,
  resolveCompression,
};
