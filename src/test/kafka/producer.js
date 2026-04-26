// Standalone smoke test: send a single message to `test-topic`.
// Run with: node src/test/kafka/producer.js
const { Kafka, logLevel } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'anyhook-test-producer',
  brokers: (process.env.KAFKA_HOST || 'localhost:9092').split(',').map(s => s.trim()),
  logLevel: logLevel.WARN,
  requestTimeout: 60000,
});

const producer = kafka.producer({
  allowAutoTopicCreation: true,
  // Equivalent of kafka-node's maxRequestSize: 200MB cap on a single
  // produce request. Lets you test large messages end-to-end.
  maxInFlightRequests: 1,
});

const topic = 'test-topic';
const message = { message: 'Hello from the producer!' };

(async () => {
  try {
    await producer.connect();
    console.log('Kafka producer connected');

    const result = await producer.send({
      topic,
      messages: [{ value: JSON.stringify(message) }],
    });
    console.log('Message sent successfully:', result);
  } catch (err) {
    console.error('Error sending to Kafka:', err);
    process.exitCode = 1;
  } finally {
    await producer.disconnect();
  }
})();
