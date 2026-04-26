require('dotenv').config({ path: './.env' });
const { SubscriptionClient } = require('subscriptions-transport-ws');
const WebSocket = require('ws');
const gql = require('graphql-tag');

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

// Create a WebSocket client for subscriptions
const client = new SubscriptionClient(endpoint, {
    reconnect: true,
}, WebSocket);

// Log connection events
client.onConnected(() => {
    console.log('WebSocket connected');
});

client.onConnecting(() => {
    console.log('WebSocket connecting...');
});

client.onReconnecting(() => {
    console.log('WebSocket reconnecting...');
});

client.onReconnected(() => {
    console.log('WebSocket reconnected');
});

client.onDisconnected(() => {
    console.log('WebSocket disconnected');
});

client.onError((error) => {
    console.error('WebSocket error:', error);
});

// Subscribe to the GraphQL event
const subscription = client.request({ query }).subscribe({
    next(data) {
        console.log('Received data:', JSON.stringify(data, null, 2));
    },
    error(err) {
        console.error('Subscription error:', err);
    },
    complete() {
        console.log('Subscription completed');
    },
});

// Additional logging for subscription status
setTimeout(() => {
    if (!subscription) {
        console.error('Subscription could not be established');
    } else {
        console.log('Subscription initiated');
    }
}, 5000);
