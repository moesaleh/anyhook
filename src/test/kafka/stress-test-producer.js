// Throughput benchmark: send N messages of size K, time it.
// Run with: node src/test/kafka/stress-test-producer.js
const { Kafka, CompressionTypes, logLevel } = require('kafkajs');
const { performance } = require('perf_hooks');

const kafka = new Kafka({
  clientId: 'anyhook-stress-test',
  brokers: (process.env.KAFKA_HOST || 'localhost:9092').split(',').map(s => s.trim()),
  logLevel: logLevel.WARN,
  requestTimeout: 600000,
});

const producer = kafka.producer({ allowAutoTopicCreation: true });

const topic = 'test-topic';
const numberOfMessages = parseInt(process.env.STRESS_N, 10) || 10000;
const messageSizeInKB = parseInt(process.env.STRESS_KB, 10) || 2;
const batchSize = parseInt(process.env.STRESS_BATCH, 10) || 100;

function createMessage(sizeInKB) {
  return JSON.stringify({ message: 'A'.repeat(sizeInKB * 1024) });
}

(async () => {
  try {
    await producer.connect();
    console.log(
      `Sending ${numberOfMessages} messages of ${messageSizeInKB}KB in batches of ${batchSize}...`
    );

    const startTime = performance.now();

    // Batched sends — kafkajs handles batching internally per-broker but
    // chunking the submit loop reduces JS event-loop pressure with large N.
    for (let i = 0; i < numberOfMessages; i += batchSize) {
      const messages = [];
      for (let j = 0; j < batchSize && i + j < numberOfMessages; j++) {
        messages.push({ value: createMessage(messageSizeInKB) });
      }
      await producer.send({
        topic,
        compression: CompressionTypes.None,
        messages,
      });
    }

    const duration = (performance.now() - startTime) / 1000;
    console.log(`Sent ${numberOfMessages} messages in ${duration.toFixed(2)}s`);
    console.log(`Average throughput: ${(numberOfMessages / duration).toFixed(2)} messages/second`);
    console.log(
      `Average bandwidth: ${((numberOfMessages * messageSizeInKB) / duration / 1024).toFixed(2)} MB/s`
    );
  } catch (err) {
    console.error('Stress test failed:', err);
    process.exitCode = 1;
  } finally {
    await producer.disconnect();
  }
})();
