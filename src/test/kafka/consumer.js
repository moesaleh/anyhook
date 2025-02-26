const { KafkaClient, Consumer } = require('kafka-node');

// Kafka client with increased fetchMaxBytes for handling larger messages
const kafkaClient = new KafkaClient({
  kafkaHost: 'localhost:9092',
  requestTimeout: 30000,  // Optional: increase the request timeout (in ms)
});

const consumer = new Consumer(kafkaClient, [{ topic: 'test-topic' }], {
  autoCommit: true,
  fetchMaxBytes: 209715200,  // 200 MB limit for fetched messages
});

consumer.on('message', (message) => {
  console.log('Message received:', message.value);
});

consumer.on('error', (err) => {
  console.error('Kafka consumer error:', err);
});

consumer.on('ready', () => {
  console.log('Kafka consumer ready');
});
