const WebSocket = require('ws');
const BaseHandler = require('./baseHandler');

class WebSocketHandler extends BaseHandler {
  constructor(producer, redisClient) {
    super(producer, redisClient);
    this.wsClients = {}; // Track connections per subscription ID
  }

  connect(subscription) {
    const { args, subscription_id } = subscription;
    const { message, event_type, endpoint_url, headers } = args;

    // Close existing connection for this subscription if any
    if (this.wsClients[subscription_id]) {
      try {
        this.wsClients[subscription_id].close();
      } catch (err) {
        console.error(
          `Error closing existing WebSocket for subscription ID: ${subscription_id}`,
          err
        );
      }
      delete this.wsClients[subscription_id];
    }

    // Parse headers safely
    let parsedHeaders = {};
    if (headers) {
      try {
        parsedHeaders = typeof headers === 'object' ? headers : JSON.parse(headers);
      } catch (err) {
        console.error(`Failed to parse headers for subscription ID: ${subscription_id}`, err);
      }
    }

    // Create WebSocket client using ws
    const wsClient = new WebSocket(endpoint_url, {
      headers: parsedHeaders,
    });

    wsClient.on('open', () => {
      console.log(`WebSocket connection established for subscription ID: ${subscription_id}`);

      // If a subscription message is provided, send it when the connection is open
      if (message) {
        console.log(`Sending subscription message for subscription ID: ${subscription_id}`);
        wsClient.send(JSON.stringify(message)); // Send the provided message to subscribe
      }
    });

    wsClient.on('message', message => {
      const decodedMessage = message.toString(); // Convert message to string
      console.log(
        `WebSocket message received for subscription ID: ${subscription_id}`,
        decodedMessage
      );

      // Parse the message to check its content
      let parsedMessage;
      try {
        parsedMessage = JSON.parse(decodedMessage); // Assuming message is in JSON format
      } catch (error) {
        console.error(`Failed to parse message for subscription ID: ${subscription_id}`, error);
        return;
      }

      // If event_type is provided, filter based on event type, otherwise process all messages
      if (event_type && parsedMessage.event !== event_type) {
        console.log(
          `Event '${parsedMessage.event}' did not match expected '${event_type}' for subscription ID: ${subscription_id}`
        );
      } else {
        console.log(`Processing message for subscription ID: ${subscription_id}`);
        this.raiseConnectionEvent(subscription_id, parsedMessage);
      }
    });

    wsClient.on('close', (code, reason) => {
      console.log(
        `WebSocket connection closed for subscription ID: ${subscription_id}`,
        code,
        reason
      );
    });

    wsClient.on('error', error => {
      console.error(`WebSocket connection error for subscription ID: ${subscription_id}`, error);
    });

    // Store WebSocket client instance per subscription ID for later disconnect
    this.wsClients[subscription_id] = wsClient;
  }

  disconnect(subscriptionId) {
    if (this.wsClients[subscriptionId]) {
      this.wsClients[subscriptionId].close();
      delete this.wsClients[subscriptionId];
      console.log(`WebSocket connection closed for subscription ID: ${subscriptionId}`);
    }
  }
}

module.exports = WebSocketHandler;
