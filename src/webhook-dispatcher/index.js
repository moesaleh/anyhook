require('dotenv').config({ path: './.env' });
const { KafkaClient, Consumer, Producer } = require('kafka-node');
const redis = require('@redis/client');
const axios = require('axios');

// Initialize Kafka and Redis clients
const kafkaClient = new KafkaClient({ kafkaHost: process.env.KAFKA_HOST });
const consumer = new Consumer(kafkaClient, [{ topic: 'connection_events' }], { autoCommit: true });
const producer = new Producer(kafkaClient); // For Dead Letter Queue
const redisClient = redis.createClient({
    url: process.env.REDIS_URL,
});

// Connect to Redis
redisClient.on('error', (err) => console.error('Redis Client Error', err));
(async () => {
    await redisClient.connect();
    console.log('Redis client connected');
})();

// Retry intervals: 15 mins, 1 hour, 2 hours, 6 hours, 12 hours, 24 hours (in minutes)
const retryIntervals = [15, 60, 120, 360, 720, 1440];
const maxRetries = retryIntervals.length;

// Handle messages from the 'connection_events' topic
consumer.on('message', async (message) => {
    console.log(`Received message from Kafka topic 'connection_events':`, message.value);

    const { subscriptionId, data } = JSON.parse(message.value);

    try {
        // Read subscription details from Redis
        const subscriptionDetails = await redisClient.get(subscriptionId);

        if (!subscriptionDetails) {
            console.error(`No subscription details found for ID: ${subscriptionId}`);
            return;
        }

        const subscription = JSON.parse(subscriptionDetails);
        const { webhook_url: webhookUrl } = subscription;

        try {
            // Attempt to send data to the webhook
            await sendWebhook(subscriptionId, webhookUrl, data);
        } catch (error) {
            console.error(`Initial webhook request failed for subscription ID: ${subscriptionId}`, error);
            // Start retry process if the first attempt fails
            retryWebhook(subscriptionId, webhookUrl, data, 0);
        }
    } catch (error) {
        console.error(`Error processing message for subscription ID: ${subscriptionId}`, error);
    }
});

// Function to send webhook and handle retries
async function sendWebhook(subscriptionId, webhookUrl, data) {
    try {
        await axios.post(webhookUrl, { data });
        console.log(`Webhook sent successfully for subscription ID: ${subscriptionId}`);
    } catch (error) {
        throw new Error(`Webhook request failed for subscription ID: ${subscriptionId}: ${error.message}`);
    }
}

// Retry webhook with exponential backoff
function retryWebhook(subscriptionId, webhookUrl, data, retryCount) {
    if (retryCount >= maxRetries) {
        console.log(`Max retries reached for subscription ID: ${subscriptionId}, moving to Dead Letter Queue`);
        sendToDLQ(subscriptionId, webhookUrl, data);
        return;
    }

    const delay = retryIntervals[retryCount] * 60 * 1000; // Convert minutes to milliseconds
    console.log(`Retrying in ${retryIntervals[retryCount]} minutes for subscription ID: ${subscriptionId}`);

    setTimeout(async () => {
        try {
            await sendWebhook(subscriptionId, webhookUrl, data);
            console.log(`Webhook retry ${retryCount + 1} successful for subscription ID: ${subscriptionId}`);
        } catch (error) {
            console.error(`Retry ${retryCount + 1} failed for subscription ID: ${subscriptionId}`, error);
            retryWebhook(subscriptionId, webhookUrl, data, retryCount + 1); // Retry with next interval
        }
    }, delay);
}

// Function to send the failed message to the Dead Letter Queue (DLQ)
function sendToDLQ(subscriptionId, webhookUrl, data) {
    const payloads = [
        {
            topic: 'dlq_events',
            messages: JSON.stringify({ subscriptionId, webhookUrl, data }),
        },
    ];

    producer.send(payloads, (err, data) => {
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