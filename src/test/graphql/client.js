require('dotenv').config({ path: './.env' });
const { createClient } = require('graphql-ws');
const WebSocket = require('ws');
const gql = require('graphql-tag');
const { print } = require('graphql');

if (!process.env.BITQUERY_TOKEN) {
  console.error('BITQUERY_TOKEN environment variable is required to run this test client.');
  console.error('Get a token at https://bitquery.io and set it in your .env file.');
  process.exit(1);
}

// Define the WebSocket endpoint and subscription query
const endpoint = `wss://streaming.bitquery.io/graphql?token=${encodeURIComponent(process.env.BITQUERY_TOKEN)}`;
const query = gql`
  subscription {
    EVM(network: eth, trigger_on: head) {
      Blocks {
        Block {
          BaseFee
          BaseFeeInUSD
          Bloom
          Coinbase
        }
      }
    }
  }
`;

// Create a graphql-ws client (replaces deprecated subscriptions-transport-ws)
const client = createClient({
  url: endpoint,
  webSocketImpl: WebSocket,
  retryAttempts: 5,
  on: {
    connecting: () => console.log('WebSocket connecting...'),
    opened: () => console.log('WebSocket socket opened'),
    connected: () => console.log('WebSocket connected'),
    closed: event => console.log('WebSocket closed:', event?.code, event?.reason),
    error: err => console.error('WebSocket error:', err),
  },
});

// Subscribe to the GraphQL event
const dispose = client.subscribe(
  { query: print(query) },
  {
    next: data => {
      console.log('Received data:', JSON.stringify(data, null, 2));
    },
    error: err => {
      console.error('Subscription error:', err);
    },
    complete: () => {
      console.log('Subscription completed');
    },
  }
);

// Additional logging for subscription status
setTimeout(() => {
  if (typeof dispose === 'function') {
    console.log('Subscription initiated');
  } else {
    console.error('Subscription could not be established');
  }
}, 5000);

// Graceful shutdown so dispose runs and the socket closes cleanly
function shutdown(signal) {
  console.log(`Test client received ${signal}, disposing subscription...`);
  if (typeof dispose === 'function') dispose();
  client.dispose().finally(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
