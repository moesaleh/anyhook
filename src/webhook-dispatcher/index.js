require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const { Kafka, logLevel } = require('kafkajs');
const redis = require('@redis/client');
const axios = require('axios');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

function parseBrokers(envValue) {
    return (envValue || 'localhost:9092').split(',').map((s) => s.trim()).filter(Boolean);
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
redisClient.on('error', (err) => console.error('Redis Client Error', err));
(async () => {
    try {
        await redisClient.connect();
        console.log('Webhook dispatcher: Redis client connected');

        try {
            await pool.query('SELECT 1');
            console.log('Webhook dispatcher: PostgreSQL connected');
            await recoverPendingRetries();
        } catch (err) {
            console.error('Webhook dispatcher: PostgreSQL unavailable (recovery + delivery logging disabled):', err.message);
        }

        await producer.connect();
        await consumer.connect();
        await consumer.subscribe({ topics: ['connection_events'], fromBeginning: false });
        await consumer.run({
            eachMessage: async (payload) => {
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
             (subscription_id, event_id, status, http_status_code, response_time_ms,
              payload_size_bytes, request_body, response_body, retry_count, error_message)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                subscriptionId,
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
        const { webhook_url: webhookUrl, webhook_secret: webhookSecret } = subscription;

        try {
            await sendWebhook(subscriptionId, webhookUrl, webhookSecret, data, eventId, 0);
        } catch (error) {
            console.error(`Initial webhook request failed for subscription ID: ${subscriptionId}`, error.message);
            retryWebhook(subscriptionId, webhookUrl, webhookSecret, data, eventId, 0);
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
 * @param {string} webhookUrl - The destination URL
 * @param {string} webhookSecret - HMAC secret for signing
 * @param {any} data - The payload from the source
 * @param {string} eventId - Groups this attempt with retries
 * @param {number} retryCount - 0 for first attempt, 1+ for retries
 */
async function sendWebhook(subscriptionId, webhookUrl, webhookSecret, data, eventId, retryCount) {
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

        console.log(`Webhook sent successfully for subscription ID: ${subscriptionId} (${responseTimeMs}ms)`);

        // Record successful delivery
        await recordDelivery({
            subscriptionId,
            eventId,
            status: 'success',
            httpStatusCode: response.status,
            responseTimeMs,
            payloadSizeBytes,
            requestBody,
            responseBody: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
            retryCount,
        });
    } catch (error) {
        const responseTimeMs = Date.now() - startTime;
        const httpStatusCode = error.response?.status || null;
        const responseBody = error.response?.data
            ? (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data))
            : null;

        // Determine status: 'retrying' if more retries available, 'failed' otherwise
        const deliveryStatus = retryCount < maxRetries ? 'retrying' : 'failed';

        // Record the failed attempt
        await recordDelivery({
            subscriptionId,
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

        throw new Error(`Webhook request failed for subscription ID: ${subscriptionId}: ${error.message}`);
    }
}

/**
 * Retry webhook delivery with escalating backoff intervals.
 * Intervals: 15m → 1h → 2h → 6h → 12h → 24h → DLQ
 */
function retryWebhook(subscriptionId, webhookUrl, webhookSecret, data, eventId, retryCount) {
    if (retryCount >= maxRetries) {
        console.log(`Max retries reached for subscription ID: ${subscriptionId}, moving to Dead Letter Queue`);
        sendToDLQ(subscriptionId, webhookUrl, data, eventId);
        return;
    }

    const delay = retryIntervals[retryCount] * 60 * 1000;
    console.log(`Retrying in ${retryIntervals[retryCount]} minutes for subscription ID: ${subscriptionId} (attempt ${retryCount + 1}/${maxRetries})`);

    setTimeout(async () => {
        try {
            await sendWebhook(subscriptionId, webhookUrl, webhookSecret, data, eventId, retryCount + 1);
            console.log(`Webhook retry ${retryCount + 1} successful for subscription ID: ${subscriptionId}`);
        } catch (error) {
            console.error(`Retry ${retryCount + 1} failed for subscription ID: ${subscriptionId}`, error.message);
            retryWebhook(subscriptionId, webhookUrl, webhookSecret, data, eventId, retryCount + 1);
        }
    }, delay);
}

/**
 * Send failed delivery to the Dead Letter Queue after all retries exhausted.
 * Records a 'dlq' status delivery event.
 */
async function sendToDLQ(subscriptionId, webhookUrl, data, eventId) {
    const requestBody = JSON.stringify({ data });

    // Record DLQ entry
    await recordDelivery({
        subscriptionId,
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
            messages: [{ value: JSON.stringify({ subscriptionId, webhookUrl, data }) }],
        });
        console.log(`Message sent to Dead Letter Queue (DLQ) for subscription ID: ${subscriptionId}`);
    } catch (err) {
        console.error('Error sending to Dead Letter Queue (DLQ)', err);
    }
}

/**
 * On dispatcher startup, scan delivery_events for the most-recent row per
 * event_id with status='retrying' and re-fire the next attempt for each.
 * This recovers retries that were scheduled with in-process setTimeout in
 * a previous process lifetime and lost on restart/deploy/crash.
 *
 * Caveats:
 * - Only looks back 24h. Anything older is treated as abandoned.
 * - Single-process safe. With multiple dispatcher pods this would
 *   double-deliver — needs SELECT ... FOR UPDATE SKIP LOCKED + a status
 *   transition before that's safe to scale horizontally.
 * - request_body is truncated to 10KB at write time; recovery for payloads
 *   larger than that will replay a truncated payload.
 */
async function recoverPendingRetries() {
    let result;
    try {
        result = await pool.query(`
            SELECT DISTINCT ON (event_id)
                event_id, subscription_id, retry_count, request_body, created_at
            FROM delivery_events
            WHERE status = 'retrying'
              AND created_at > NOW() - INTERVAL '24 hours'
            ORDER BY event_id, created_at DESC
        `);
    } catch (err) {
        console.error('Failed to query delivery_events for recovery:', err.message);
        return;
    }

    if (result.rowCount === 0) {
        console.log('No pending retries to recover');
        return;
    }
    console.log(`Recovering ${result.rowCount} pending webhook retries from delivery_events`);

    for (const row of result.rows) {
        const subscriptionDetails = await redisClient.get(row.subscription_id);
        if (!subscriptionDetails) {
            console.warn(`Skipping recovery for event ${row.event_id}: subscription ${row.subscription_id} no longer in Redis`);
            continue;
        }
        let subscription;
        try {
            subscription = JSON.parse(subscriptionDetails);
        } catch (err) {
            console.error(`Skipping recovery for event ${row.event_id}: bad Redis payload`, err.message);
            continue;
        }
        const { webhook_url: webhookUrl, webhook_secret: webhookSecret } = subscription;

        let data;
        try {
            data = JSON.parse(row.request_body).data;
        } catch (err) {
            console.error(`Skipping recovery for event ${row.event_id}: cannot parse request_body (may be truncated)`, err.message);
            continue;
        }

        // row.retry_count is the attempt that just failed; the next attempt
        // is +1. Fire it immediately rather than re-waiting the original
        // backoff window — that wait already elapsed during the outage.
        const nextAttempt = row.retry_count + 1;
        console.log(`Recovering event ${row.event_id} sub ${row.subscription_id} attempt ${nextAttempt}/${maxRetries}`);
        sendWebhook(row.subscription_id, webhookUrl, webhookSecret, data, row.event_id, nextAttempt)
            .then(() => console.log(`Recovered delivery succeeded for event ${row.event_id}`))
            .catch((err) => {
                console.error(`Recovered delivery failed for event ${row.event_id}:`, err.message);
                retryWebhook(row.subscription_id, webhookUrl, webhookSecret, data, row.event_id, nextAttempt);
            });
    }
}

// Graceful shutdown — disconnect kafkajs clients, close Redis + PG, exit.
async function shutdown(signal) {
    console.log(`Webhook dispatcher received ${signal}, shutting down gracefully...`);
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
