require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const { Kafka, logLevel } = require('kafkajs');
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

function parseBrokers(envValue) {
  return (envValue || 'localhost:9092')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Initialize Kafka (kafkajs), Redis, and PostgreSQL clients
const kafka = new Kafka({
  clientId: 'webhook-dispatcher',
  brokers: parseBrokers(process.env.KAFKA_HOST),
  logLevel: logLevel.WARN,
});
const consumer = kafka.consumer({ groupId: 'webhook-dispatcher' });
const producer = kafka.producer({ allowAutoTopicCreation: false });
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

    try {
      await pool.query('SELECT 1');
      log.info('Webhook dispatcher: PostgreSQL connected');
      // Start the persistent retry poller. Crashed/restarted workers leave
      // rows in pending_retries; the next claim cycle picks them up.
      retryPollerHandle = setInterval(pollRetryQueue, RETRY_POLL_INTERVAL_MS);
      // Run one cycle immediately so we don't wait the full interval after start.
      pollRetryQueue();
      log.info(
        `Retry poller started (interval=${RETRY_POLL_INTERVAL_MS}ms, batch=${RETRY_BATCH_SIZE}, worker=${WORKER_ID})`
      );
      // Outbox drainer — same FOR UPDATE SKIP LOCKED pattern.
      outboxPollerHandle = setInterval(pollOutbox, OUTBOX_POLL_INTERVAL_MS);
      pollOutbox();
      log.info(
        `Outbox poller started (interval=${OUTBOX_POLL_INTERVAL_MS}ms, batch=${OUTBOX_BATCH_SIZE})`
      );
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
    await consumer.connect();
    await consumer.subscribe({ topics: ['connection_events'], fromBeginning: false });
    await consumer.run({
      // Manual commit so a crash mid-delivery replays the message on
      // restart. The dispatcher's producer-supplied event_id idempotency
      // check (handleConnectionEvent) means a replay won't double-fire
      // the webhook -- it'll see the existing delivery_events row and
      // skip.
      autoCommit: false,
      eachMessage: async payload => {
        try {
          await handleConnectionEvent(payload);
        } catch (err) {
          log.error('Unhandled error in connection_events handler:', err);
        }
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
let outboxPollerHandle = null;

// Notification retry poller — drains notification_attempts rows whose
// previous send failed but max_attempts hasn't been hit. Same FOR
// UPDATE SKIP LOCKED + stale-lock pattern.
const NOTIFICATION_POLL_INTERVAL_MS =
  parseInt(process.env.NOTIFICATION_POLL_INTERVAL_MS, 10) || 60 * 1000;
const NOTIFICATION_BATCH_SIZE =
  parseInt(process.env.NOTIFICATION_BATCH_SIZE, 10) || 25;
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
  // duplicate-detection branch below skips the redelivered message.
  // Older in-flight messages without eventId fall back to a fresh uuid.
  const eventId = payloadEventId || uuidv4();

  try {
    // Idempotency: if we've already recorded any delivery_events row
    // for this (subscription, event) pair, the message is a Kafka
    // redelivery and the original chain is already in flight or
    // complete. Skip — don't produce a second parallel retry chain.
    if (payloadEventId) {
      try {
        const existing = await pool.query(
          `SELECT 1 FROM delivery_events
           WHERE subscription_id = $1 AND event_id = $2 LIMIT 1`,
          [subscriptionId, payloadEventId]
        );
        if (existing.rowCount > 0) {
          log.info(
            `Skipping duplicate delivery for subscription=${subscriptionId} event=${payloadEventId}`
          );
          return;
        }
      } catch (err) {
        // PG unavailable — fall through; we'd rather risk a duplicate
        // delivery than drop the legitimate event.
        log.error('Idempotency check failed (proceeding):', err.message);
      }
    }

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

  try {
    // Pass the pre-serialized body so the HMAC matches exactly what the
    // receiver hashes. axios would otherwise re-serialize the object.
    const response = await axios.post(webhookUrl, requestBody, {
      timeout: 30000,
      headers,
    });
    const responseTimeMs = Date.now() - startTime;

    log.info(
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
    log.info(
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
  } catch {
    // sendWebhook already wrote a delivery_events row with status='retrying'
    // or 'failed' depending on whether more retries remain.
    if (nextAttempt >= maxRetries) {
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
 * Outbox drainer.
 *
 * Hot loop:
 *   1. Stale-lock sweep: any row locked_at < now - OUTBOX_LOCK_TIMEOUT
 *      gets unlocked (a previous worker crashed mid-publish).
 *   2. Claim a batch with FOR UPDATE SKIP LOCKED.
 *   3. For each row: producer.send. On success → mark delivered.
 *      On failure → unlock + bump attempts + record last_error so the
 *      next sweep retries.
 *
 * Multi-pod safe via SKIP LOCKED + locked_by tracking.
 */
async function pollOutbox() {
  // Stale-lock sweep — fire and forget; if it fails we still try to claim.
  pool
    .query(
      `UPDATE outbox_events
       SET locked_at = NULL, locked_by = NULL
       WHERE delivered_at IS NULL AND locked_at IS NOT NULL
         AND locked_at < NOW() - ($1::text || ' milliseconds')::interval`,
      [String(OUTBOX_LOCK_TIMEOUT_MS)]
    )
    .catch(err => log.error('Outbox stale-lock sweep failed:', err.message));

  // Update the per-topic backlog gauge. Cheap GROUP BY; runs every
  // poll cycle so the alert (outbox_pending_total > 100) sees fresh
  // data. Eventual consistency is fine for a metric.
  pool
    .query(
      `SELECT topic, COUNT(*)::int AS n
       FROM outbox_events
       WHERE delivered_at IS NULL
       GROUP BY topic`
    )
    .then(r => {
      outboxPendingGauge.reset();
      for (const row of r.rows) {
        outboxPendingGauge.set({ topic: row.topic }, row.n);
      }
    })
    .catch(() => {});

  // Same for notification_attempts — surfaces the "alerts pending
  // retry" signal that the dashboard / alerts can use.
  pool
    .query(
      `SELECT status, COUNT(*)::int AS n
       FROM notification_attempts
       WHERE status IN ('pending', 'failed')
       GROUP BY status`
    )
    .then(r => {
      notificationAttemptsGauge.reset();
      for (const row of r.rows) {
        notificationAttemptsGauge.set({ status: row.status }, row.n);
      }
    })
    .catch(() => {});

  let claimed;
  try {
    const result = await pool.query(
      `WITH due AS (
          SELECT id FROM outbox_events
          WHERE delivered_at IS NULL AND locked_at IS NULL
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_events o
       SET locked_at = NOW(), locked_by = $2
       FROM due
       WHERE o.id = due.id
       RETURNING o.*`,
      [OUTBOX_BATCH_SIZE, WORKER_ID]
    );
    claimed = result.rows;
  } catch (err) {
    log.error('Outbox claim failed:', err.message);
    return;
  }
  if (claimed.length === 0) return;

  for (const row of claimed) {
    try {
      await producer.send({
        topic: row.topic,
        messages: [{ key: row.message_key, value: row.message_value }],
      });
      await pool.query(
        'UPDATE outbox_events SET delivered_at = NOW(), locked_at = NULL, locked_by = NULL WHERE id = $1',
        [row.id]
      );
    } catch (err) {
      log.error(`Outbox publish failed for row ${row.id}:`, err.message);
      // Unlock + bump attempts + record error. Next sweep retries.
      await pool
        .query(
          `UPDATE outbox_events
           SET locked_at = NULL, locked_by = NULL,
               attempts = attempts + 1, last_error = $1
           WHERE id = $2`,
          [String(err.message).slice(0, 500), row.id]
        )
        .catch(() => {});
    }
  }
}

// Graceful shutdown — stop the retry poller, disconnect kafkajs clients,
// close Redis + PG, exit. Stopping the poller first means in-flight retries
// finish; new ones won't be claimed.
async function shutdown(signal) {
  log.info(`Webhook dispatcher received ${signal}, shutting down gracefully...`);
  if (retryPollerHandle) {
    clearInterval(retryPollerHandle);
    retryPollerHandle = null;
  }
  if (outboxPollerHandle) {
    clearInterval(outboxPollerHandle);
    outboxPollerHandle = null;
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
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
