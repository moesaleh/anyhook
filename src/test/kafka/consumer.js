// Standalone smoke test: tail messages from `test-topic`.
// Run with: node src/test/kafka/consumer.js
const { Kafka, logLevel } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'anyhook-test-consumer',
  brokers: (process.env.KAFKA_HOST || 'localhost:9092').split(',').map(s => s.trim()),
  logLevel: logLevel.WARN,
  requestTimeout: 30000,
});

// Use a per-process random groupId so multiple test runs don't share offsets
// and step on each other. Real services use a stable groupId.
const consumer = kafka.consumer({
  groupId: `anyhook-test-consumer-${process.pid}-${Date.now()}`,
});

(async () => {
  try {
    await consumer.connect();
    console.log('Kafka consumer connected');

    await consumer.subscribe({ topic: 'test-topic', fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        console.log(
          `[${topic}/${partition}] offset=${message.offset} value=${message.value && message.value.toString()}`
        );
      },
    });
  } catch (err) {
    console.error('Kafka consumer error:', err);
    process.exitCode = 1;
  }
})();

async function shutdown(signal) {
  console.log(`\nReceived ${signal}, disconnecting...`);
  await consumer.disconnect();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
