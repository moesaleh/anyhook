require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const redis = require('@redis/client');
const { Kafka, logLevel } = require('kafkajs');
const promClient = require('prom-client');
const { createLogger } = require('../lib/logger');
const { startMetricsServer } = require('../lib/metrics-server');
const GraphQLHandler = require('./handlers/graphqlHandler');
const WebSocketHandler = require('./handlers/webSocketHandler');

const log = createLogger('subscription-connector');

// Service-specific metrics
const subscriptionEventsHandled = new promClient.Counter({
  name: 'connector_subscription_events_total',
  help: 'Total Kafka events handled by the connector',
  labelNames: ['topic', 'outcome'],
});

function parseBrokers(envValue) {
  return (envValue || 'localhost:9092')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
const kafka = new Kafka({
  clientId: 'subscription-connector',
  brokers: parseBrokers(process.env.KAFKA_HOST),
  logLevel: logLevel.WARN,
});
const producer = kafka.producer({ allowAutoTopicCreation: false });
const consumer = kafka.consumer({ groupId: 'subscription-connector' });

// Connection handlers (pluggable). Constructed once with the shared producer
// + redis client; one instance handles ALL subscriptions of its type.
const connectionHandlers = {
  graphql: new GraphQLHandler(producer, redisClient),
  websocket: new WebSocketHandler(producer, redisClient),
};

redisClient.on('error', err => log.error('Redis Client Error', err));

// Reload subscriptions present in Redis on startup so connections survive
// connector restarts. Runs after Redis connect, before consumer.run().
async function reloadActiveSubscriptions() {
  try {
    // SCAN, not KEYS — KEYS blocks Redis on large keyspaces.
    const subscriptionIds = [];
    let cursor = 0;
    do {
      const result = await redisClient.scan(cursor, { COUNT: 100 });
      cursor = result.cursor;
      subscriptionIds.push(...result.keys);
    } while (cursor !== 0);

    log.info(`Found ${subscriptionIds.length} subscriptions in Redis to reload`);

    for (const subscriptionId of subscriptionIds) {
      const subscriptionDetails = await redisClient.get(subscriptionId);
      if (!subscriptionDetails) continue;
      const subscription = JSON.parse(subscriptionDetails);
      const handler = connectionHandlers[subscription.connection_type];
      if (handler) {
        log.info(`Re-establishing connection for subscription ID: ${subscriptionId}`);
        handler.connect(subscription);
      } else {
        log.error(`No handler found for connection type: ${subscription.connection_type}`);
      }
    }
  } catch (err) {
    log.error('Error reloading subscriptions from Redis:', err);
  }
}

async function handleMessage({ topic, message }) {
  const subscriptionId = message.value ? message.value.toString() : null;
  if (!subscriptionId) {
    log.error(`Received empty message on topic ${topic}`);
    return;
  }
  log.info(`Received message from topic: ${topic} with subscriptionId: ${subscriptionId}`);

  if (topic === 'subscription_events') {
    try {
      const subscriptionDetails = await redisClient.get(subscriptionId);
      if (!subscriptionDetails) {
        log.error(`No subscription details found in Redis for ID: ${subscriptionId}`);
        return;
      }
      const subscription = JSON.parse(subscriptionDetails);
      const handler = connectionHandlers[subscription.connection_type];
      if (!handler) {
        log.error(`No handler found for connection type: ${subscription.connection_type}`);
        return;
      }
      handler.connect(subscription);
    } catch (err) {
      log.error('Error handling subscription_events:', err);
    }
    return;
  }

  if (topic === 'update_events') {
    // Subscription config changed — tear down the existing connection
    // and reopen with the new config from Redis.
    try {
      const subscriptionDetails = await redisClient.get(subscriptionId);
      if (!subscriptionDetails) {
        log.error(`No subscription details found in Redis for update event: ${subscriptionId}`);
        return;
      }
      const subscription = JSON.parse(subscriptionDetails);
      const handler = connectionHandlers[subscription.connection_type];
      if (!handler) {
        log.error(`No handler found for connection type: ${subscription.connection_type}`);
        return;
      }
      log.info(`Reloading subscription ID: ${subscriptionId} (update event)`);
      handler.disconnect(subscriptionId);
      handler.connect(subscription);
    } catch (err) {
      log.error('Error processing update event:', err);
    }
    return;
  }

  if (topic === 'unsubscribe_events') {
    try {
      const subscriptionDetails = await redisClient.get(subscriptionId);
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
        // Subscription already removed from Redis — nothing to disconnect
        log.warn(`Unsubscribe event for ${subscriptionId} but no Redis entry`);
      }
      // Always remove from Redis to keep cache + DB consistent
      await redisClient.del(subscriptionId);
    } catch (err) {
      log.error('Error handling unsubscribe_events:', err);
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

    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({
      topics: ['subscription_events', 'unsubscribe_events', 'update_events'],
      fromBeginning: false,
    });

    // Reload from Redis BEFORE starting the consumer so we don't process
    // a 'subscription_events' for a sub we just reloaded from Redis.
    await reloadActiveSubscriptions();

    await consumer.run({
      eachMessage: async payload => {
        try {
          await handleMessage(payload);
          subscriptionEventsHandled.inc({ topic: payload.topic, outcome: 'ok' });
        } catch (err) {
          subscriptionEventsHandled.inc({ topic: payload.topic, outcome: 'error' });
          log.error('Unhandled error in consumer message handler:', err);
        }
      },
    });

    log.info('Subscription connector ready');
  } catch (err) {
    log.error('Failed to start subscription-connector:', err);
    process.exit(1);
  }
})();

// Graceful shutdown — disconnect Kafka clients, close Redis, then exit.
async function shutdown(signal) {
  log.info(`Subscription connector received ${signal}, shutting down gracefully...`);
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
