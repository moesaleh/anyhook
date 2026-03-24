require('dotenv').config({ path: './.env' });
const { KafkaClient, Consumer, Producer } = require('kafka-node');
const redis = require('@redis/client');
const axios = require('axios');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Initialize Kafka, Redis, and PostgreSQL clients
const kafkaClient = new KafkaClient({ kafkaHost: process.env.KAFKA_HOST });
const consumer = new Consumer(kafkaClient, [{ topic: 'connection_events' }], { autoCommit: true });
const producer = new Producer(kafkaClient);
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Connect to Redis
redisClient.on('error', (err) => console.error('Redis Client Error', err));
(async () => {
    await redisClient.connect();
    console.log('Webhook dispatcher: Redis client connected');
})();

// Verify PostgreSQL connection
pool.query('SELECT 1').then(() => {
    console.log('Webhook dispatcher: PostgreSQL connected');
}).catch((err) => {
    console.error('Webhook dispatcher: PostgreSQL connection failed (delivery logging will be unavailable):', err.message);
});

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

// Handle messages from the 'connection_events' topic
consumer.on('message', async (message) => {
    console.log(`Received message from Kafka topic 'connection_events':`, message.value);

    const { subscriptionId, data } = JSON.parse(message.value);

    // Generate a unique event ID that groups this delivery + all its retries
    const eventId = uuidv4();

    try {
        const subscriptionDetails = await redisClient.get(subscriptionId);

        if (!subscriptionDetails) {
            console.error(`No subscription details found for ID: ${subscriptionId}`);
            return;
        }

        const subscription = JSON.parse(subscriptionDetails);
        const { webhook_url: webhookUrl } = subscription;

        try {
            await sendWebhook(subscriptionId, webhookUrl, data, eventId, 0);
        } catch (error) {
            console.error(`Initial webhook request failed for subscription ID: ${subscriptionId}`, error.message);
            retryWebhook(subscriptionId, webhookUrl, data, eventId, 0);
        }
    } catch (error) {
        console.error(`Error processing message for subscription ID: ${subscriptionId}`, error);
    }
});

/**
 * Send a webhook POST and record the outcome.
 * @param {string} subscriptionId - The subscription UUID
 * @param {string} webhookUrl - The destination URL
 * @param {any} data - The payload from the source
 * @param {string} eventId - Groups this attempt with retries
 * @param {number} retryCount - 0 for first attempt, 1+ for retries
 */
async function sendWebhook(subscriptionId, webhookUrl, data, eventId, retryCount) {
    const requestBody = JSON.stringify({ data });
    const payloadSizeBytes = Buffer.byteLength(requestBody, 'utf8');
    const startTime = Date.now();

    try {
        const response = await axios.post(webhookUrl, { data });
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
function retryWebhook(subscriptionId, webhookUrl, data, eventId, retryCount) {
    if (retryCount >= maxRetries) {
        console.log(`Max retries reached for subscription ID: ${subscriptionId}, moving to Dead Letter Queue`);
        sendToDLQ(subscriptionId, webhookUrl, data, eventId);
        return;
    }

    const delay = retryIntervals[retryCount] * 60 * 1000;
    console.log(`Retrying in ${retryIntervals[retryCount]} minutes for subscription ID: ${subscriptionId} (attempt ${retryCount + 1}/${maxRetries})`);

    setTimeout(async () => {
        try {
            await sendWebhook(subscriptionId, webhookUrl, data, eventId, retryCount + 1);
            console.log(`Webhook retry ${retryCount + 1} successful for subscription ID: ${subscriptionId}`);
        } catch (error) {
            console.error(`Retry ${retryCount + 1} failed for subscription ID: ${subscriptionId}`, error.message);
            retryWebhook(subscriptionId, webhookUrl, data, eventId, retryCount + 1);
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

    const payloads = [
        {
            topic: 'dlq_events',
            messages: JSON.stringify({ subscriptionId, webhookUrl, data }),
        },
    ];

    producer.send(payloads, (err) => {
        if (err) {
            console.error('Error sending to Dead Letter Queue (DLQ)', err);
        } else {
            console.log(`Message sent to Dead Letter Queue (DLQ) for subscription ID: ${subscriptionId}`);
        }
    });
}

// Error handling for Kafka consumer
consumer.on('error', (err) => {
    console.error('Error in Kafka Consumer:', err);
});
