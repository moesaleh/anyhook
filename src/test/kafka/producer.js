const { KafkaClient, Producer } = require('kafka-node');

// Kafka client with increased maxRequestSize for handling larger messages
const kafkaClient = new KafkaClient({
  kafkaHost: 'localhost:9092',
  requestTimeout: 60000,  // Optional, increase the request timeout (in ms)
});

const producer = new Producer(kafkaClient, {
  maxRequestSize: 209715200,  // 200 MB limit for requests
});

const topic = 'test-topic';
const message = {
  message: 'Hello from the producer!',
};

producer.on('ready', () => {
  console.log('Kafka producer ready');
  
  const payloads = [
    { topic, messages: JSON.stringify(message) },
  ];

  // Send the message
  producer.send(payloads, (err, data) => {
    if (err) {
      console.error('Error sending to Kafka:', err);
    } else {
      console.log('Message sent successfully:', data);
    }
  });
});

producer.on('error', (err) => {
  console.error('Kafka producer error:', err);
});
