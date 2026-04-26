require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const { Kafka, logLevel } = require('kafkajs');
const redis = require('@redis/client');
const axios = require('axios');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

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

// Connect Redis + PG, recover any in-flight retries lost on restart, then
// connect Kafka producer/consumer and start consuming.
redisClient.on('error', err => console.error('Redis Client Error', err));
(async () => {
  try {
    await redisClient.connect();
    console.log('Webhook dispatcher: Redis client connected');

    try {
      await pool.query('SELECT 1');
      console.log('Webhook dispatcher: PostgreSQL connected');
      // Start the persistent retry poller. Crashed/restarted workers leave
      // rows in pending_retries; the next claim cycle picks them up.
      retryPollerHandle = setInterval(pollRetryQueue, RETRY_POLL_INTERVAL_MS);
      // Run one cycle immediately so we don't wait the full interval after start.
      pollRetryQueue();
      console.log(
        `Retry poller started (interval=${RETRY_POLL_INTERVAL_MS}ms, batch=${RETRY_BATCH_SIZE}, worker=${WORKER_ID})`
      );
    } catch (err) {
      console.error(
        'Webhook dispatcher: PostgreSQL unavailable (retry queue + delivery logging disabled):',
        err.message
      );
    }

    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topics: ['connection_events'], fromBeginning: false });
    await consumer.run({
      eachMessage: async payload => {
        try {
          await handleConnectionEvent(payload);
        } catch (err) {
          console.error('Unhandled error in connection_events handler:', err);
        }
      },
    });
    console.log('Webhook dispatcher ready');
  } catch (err) {
    console.error('Failed to start webhook-dispatcher:', err);
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
    console.error(`Failed to record delivery event for ${subscriptionId}:`, err.message);
  }
}

// Handle a single message from 'connection_events'.
async function handleConnectionEvent({ message }) {
  const raw = message.value ? message.value.toString() : null;
  if (!raw) {
    console.error('Received empty message on connection_events, skipping');
    return;
  }

  let subscriptionId, data;
  try {
    ({ subscriptionId, data } = JSON.parse(raw));
  } catch (err) {
    console.error('Failed to parse Kafka message, skipping:', err.message);
    return;
  }

  if (!subscriptionId) {
    console.error('Missing subscriptionId in Kafka message, skipping');
    return;
  }

  // Generate a unique event ID that groups this delivery + all its retries
  const eventId = uuidv4();

  try {
    const subscriptionDetails = await redisClient.get(subscriptionId);

    if (!subscriptionDetails) {
      console.error(`No subscription details found for ID: ${subscriptionId}`);
      return;
    }

    const subscription = JSON.parse(subscriptionDetails);
    const {
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
      organization_id: organizationId,
    } = subscription;

    if (!organizationId) {
      console.error(
        `Subscription ${subscriptionId} has no organization_id; cannot record delivery`
      );
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
      console.error(
        `Initial webhook request failed for subscription ID: ${subscriptionId}`,
        error.message
      );
      // Enqueue for the persistent poller instead of using setTimeout. The
      // poller will pick it up at next_attempt_at and re-fire via processClaimedRetry.
      await enqueueRetry(eventId, subscriptionId, organizationId, JSON.stringify({ data }), 0);
    }
  } catch (error) {
    console.error(`Error processing message for subscription ID: ${subscriptionId}`, error);
  }
}

/**
 * Compute the standard webhook signature header value.
 * Format: `t=<unix_seconds>,v1=<hex_hmac_sha256>` over `<timestamp>.<body>`.
 * The timestamped scheme prevents replay attacks; receivers should reject
 * timestamps older than ~5 minutes.
 */
function signRequest(secret, timestampSec, rawBody) {
  const payload = `${timestampSec}.${rawBody}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { signature: `t=${timestampSec},v1=${hmac}`, hmac };
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
    console.warn(`No webhook_secret for subscription ${subscriptionId}; sending UNSIGNED`);
  }

  try {
    // Pass the pre-serialized body so the HMAC matches exactly what the
    // receiver hashes. axios would otherwise re-serialize the object.
    const response = await axios.post(webhookUrl, requestBody, {
      timeout: 30000,
      headers,
    });
    const responseTimeMs = Date.now() - startTime;

    console.log(
      `Webhook sent successfully for subscription ID: ${subscriptionId} (${responseTimeMs}ms)`
    );

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

    // Determine status: 'retrying' if more retries available, 'failed' otherwise
    const deliveryStatus = retryCount < maxRetries ? 'retrying' : 'failed';

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
    await pool.query(
      `INSERT INTO pending_retries
         (event_id, subscription_id, organization_id, request_body,
          retry_count, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO UPDATE SET
          retry_count = EXCLUDED.retry_count,
          next_attempt_at = EXCLUDED.next_attempt_at,
          locked_at = NULL,
          locked_by = NULL`,
      [eventId, subscriptionId, organizationId, requestBody, retryCount, nextAttemptAt]
    );
    console.log(
      `Enqueued retry for event ${eventId} attempt ${retryCount + 1}/${maxRetries} at ${nextAttemptAt.toISOString()}`
    );
  } catch (err) {
    console.error(`Failed to enqueue retry for event ${eventId}:`, err.message);
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
    .catch(err => console.error('Stale-lock sweep failed:', err.message));

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
  const subscriptionDetails = await redisClient.get(row.subscription_id);

  // Subscription deleted between schedule and retry — drop the queue row,
  // record a final 'failed' delivery_event for audit. The FK CASCADE on
  // sub deletion would normally handle this, but we may also race deletion.
  if (!subscriptionDetails) {
    console.warn(
      `Subscription ${row.subscription_id} no longer in Redis; dropping retry ${row.event_id}`
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
    return;
  }

  let subscription;
  try {
    subscription = JSON.parse(subscriptionDetails);
  } catch (err) {
    console.error(`Bad Redis payload for ${row.subscription_id}:`, err.message);
    // Don't drop the queue row — the Redis state may recover. Just unlock.
    await pool.query(
      'UPDATE pending_retries SET locked_at = NULL, locked_by = NULL WHERE event_id = $1',
      [row.event_id]
    );
    return;
  }
  const { webhook_url: webhookUrl, webhook_secret: webhookSecret } = subscription;

  let data;
  try {
    data = JSON.parse(row.request_body).data;
  } catch (err) {
    console.error(
      `Cannot parse request_body for event ${row.event_id} (truncated?):`,
      err.message
    );
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
  let claimed;
  try {
    claimed = await claimDueRetries();
  } catch (err) {
    console.error('Failed to claim retries:', err.message);
    return;
  }
  if (claimed.length === 0) return;

  console.log(`Processing ${claimed.length} due retries (worker ${WORKER_ID})`);
  for (const row of claimed) {
    try {
      await processClaimedRetry(row);
    } catch (err) {
      console.error(`Retry processing failed for event ${row.event_id}:`, err.message);
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
 * Records a 'dlq' status delivery event.
 */
async function sendToDLQ(subscriptionId, organizationId, webhookUrl, data, eventId) {
  const requestBody = JSON.stringify({ data });

  // Record DLQ entry
  await recordDelivery({
    subscriptionId,
    organizationId,
    eventId,
    status: 'dlq',
    retryCount: maxRetries,
    payloadSizeBytes: Buffer.byteLength(requestBody, 'utf8'),
    requestBody,
    errorMessage: 'Max retries exceeded, moved to Dead Letter Queue',
  });

  try {
    await producer.send({
      topic: 'dlq_events',
      messages: [{ value: JSON.stringify({ subscriptionId, organizationId, webhookUrl, data }) }],
    });
    console.log(`Message sent to Dead Letter Queue (DLQ) for subscription ID: ${subscriptionId}`);
  } catch (err) {
    console.error('Error sending to Dead Letter Queue (DLQ)', err);
  }
}


// Graceful shutdown — stop the retry poller, disconnect kafkajs clients,
// close Redis + PG, exit. Stopping the poller first means in-flight retries
// finish; new ones won't be claimed.
async function shutdown(signal) {
  console.log(`Webhook dispatcher received ${signal}, shutting down gracefully...`);
  if (retryPollerHandle) {
    clearInterval(retryPollerHandle);
    retryPollerHandle = null;
  }
  const forceExit = setTimeout(() => {
    console.error('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10000);
  try {
    await Promise.allSettled([
      consumer.disconnect(),
      producer.disconnect(),
      redisClient.quit(),
      pool.end(),
    ]);
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
