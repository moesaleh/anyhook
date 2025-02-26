const { KafkaClient, Producer } = require('kafka-node');
const { performance } = require('perf_hooks');

// Kafka client with increased maxRequestSize for handling larger messages
const kafkaClient = new KafkaClient({
  kafkaHost: 'localhost:9092',
  requestTimeout: 600000,  // Optional, increase the request timeout (in ms)
});

const producer = new Producer(kafkaClient, {
  maxRequestSize: 209715200,  // 200 MB limit for requests
});

const topic = 'test-topic';

// Function to generate a large message for testing
function createMessage(sizeInKB) {
  return {
    message: 'A'.repeat(sizeInKB * 1024),  // Fill the message with 'x' to simulate a large payload
  };
}

// Number of messages to send and their size
const numberOfMessages = 10000;
const messageSizeInKB = 2;  // Size of each message in kilobytes

// Track start time for benchmarking
let messagesSent = 0;
const startTime = performance.now();

producer.on('ready', () => {
  console.log('Kafka producer ready');

  for (let i = 0; i < numberOfMessages; i++) {
    const message = createMessage(messageSizeInKB);

    const payloads = [
      { topic, messages: JSON.stringify(message) },
    ];

    // Send the message
    producer.send(payloads, (err) => {
      if (err) {
        console.error('Error sending to Kafka:', err);
      } else {
        messagesSent++;
        if (messagesSent === numberOfMessages) {
          const endTime = performance.now();
          const duration = (endTime - startTime) / 1000;
          console.log(`Sent ${numberOfMessages} messages in ${duration.toFixed(2)} seconds`);
          console.log(`Average throughput: ${(numberOfMessages / duration).toFixed(2)} messages/second`);
        }
      }
    });
  }
});

producer.on('error', (err) => {
  console.error('Kafka producer error:', err);
});
