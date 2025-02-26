const { SubscriptionClient } = require('subscriptions-transport-ws');
const WebSocket = require('ws');
const gql = require('graphql-tag');

// Define the WebSocket endpoint and subscription query
const endpoint = 'wss://streaming.bitquery.io/graphql?token=ory_at_P9weJTGfrKcoYil2keWSQ5YfqqySRKIAgmRhUKjhEI8.rlGPL9v8TyTNINqGTGob8ZAPoeCRDr8nEGiMGeJMSJo';
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
