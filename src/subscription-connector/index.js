require('dotenv').config({ path: './.env' });
const redis = require('@redis/client');
const { KafkaClient, Consumer, Producer } = require('kafka-node');
const GraphQLHandler = require('./handlers/graphqlHandler');
const WebSocketHandler = require('./handlers/webSocketHandler');

// Initialize Redis and Kafka
const redisClient = redis.createClient({
    url: process.env.REDIS_URL,
});
const kafkaClient = new KafkaClient({ kafkaHost: process.env.KAFKA_HOST });
const producer = new Producer(kafkaClient);

// Connect to Redis
redisClient.on('error', (err) => console.error('Redis Client Error', err));
(async () => {
    await redisClient.connect();
    console.log('Redis client connected');

    // Reload active subscriptions from Redis
    await reloadActiveSubscriptions();
})();

// Define Kafka consumers to listen to subscription and unsubscription events
const consumer = new Consumer(
    kafkaClient,
    [{ topic: 'subscription_events' }, { topic: 'unsubscribe_events' }],
    { autoCommit: true }
);

// Connection handlers (pluggable)
const connectionHandlers = {
    graphql: new GraphQLHandler(producer, redisClient),
    websocket: new WebSocketHandler(producer, redisClient),
};

// Function to reload active subscriptions from Redis and reconnect them
async function reloadActiveSubscriptions() {
    try {
        const keys = await redisClient.keys('*'); // Fetch all subscription keys
        console.log(`Found ${keys.length} subscriptions in Redis to reload`);

        for (const subscriptionId of keys) {
            const subscriptionDetails = await redisClient.get(subscriptionId);
            if (subscriptionDetails) {
                const subscription = JSON.parse(subscriptionDetails);
                console.log(`Re-establishing connection for subscription ID: ${subscriptionId}`);
                const handler = connectionHandlers[subscription.connection_type];
                if (handler) {
                    handler.connect(subscription);
                } else {
                    console.error(`No handler found for connection type: ${subscription.connection_type}`);
                }
            }
        }
    } catch (err) {
        console.error('Error reloading subscriptions from Redis:', err);
    }
}

// Listen for Kafka messages from 'subscription_events' and 'unsubscribe_events'
consumer.on('message', async (message) => {
    const subscriptionId = message.value;
    const topic = message.topic;

    console.log(`Received message from topic: ${topic} with subscriptionId: ${subscriptionId}`);

    if (topic === 'subscription_events') {
        try {
            const subscriptionDetails = await redisClient.get(subscriptionId);
            if (subscriptionDetails) {
                console.log(`Subscription details found in Redis for ID: ${subscriptionId}`);
                const subscription = JSON.parse(subscriptionDetails);
                console.log(`Connection type: ${subscription.connection_type}`);
                const handler = connectionHandlers[subscription.connection_type];
                if (handler) {
                    handler.connect(subscription);
                } else {
                    console.error(`No handler found for connection type: ${subscription.connection_type}`);
                }
            } else {
                console.error(`No subscription details found in Redis for ID: ${subscriptionId}`);
            }
        } catch (err) {
            console.error('Error retrieving subscription from Redis', err);
        }
    } else if (topic === 'unsubscribe_events') {
        try {
            const subscriptionDetails = await redisClient.get(subscriptionId);
            if (subscriptionDetails) {
                console.log(`Subscription details found in Redis for ID: ${subscriptionId}`);
                const subscription = JSON.parse(subscriptionDetails);
                const handler = connectionHandlers[subscription.connection_type];
                if (handler) {
                    handler.disconnect(subscriptionId);
                    console.log(`Disconnected from ${subscription.connection_type} for subscription ID: ${subscriptionId}`);
                } else {
                    console.error(`No handler found for connection type: ${subscription.connection_type}`);
                }
            } else {
                console.error(`No subscription details found in Redis for ID: ${subscriptionId}`);
            }

            // Delete subscription from Redis
            redisClient.del(subscriptionId);
        } catch (err) {
            console.error('Error retrieving subscription from Redis', err);
        }
    }
});

// Error handling for Kafka consumer
consumer.on('error', (err) => {
    console.error('Error in Kafka Consumer:', err);
});
