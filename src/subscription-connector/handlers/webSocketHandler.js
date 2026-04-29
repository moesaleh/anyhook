const WebSocket = require('ws');
const BaseHandler = require('./baseHandler');
const { createLogger } = require('../../lib/logger');
const { ReconnectScheduler } = require('../reconnect');

const log = createLogger('websocket-handler');

class WebSocketHandler extends BaseHandler {
  constructor(producer, redisClient) {
    super(producer, redisClient);
    this.wsClients = {}; // Track connections per subscription ID
    this.subscriptions = {}; // Cached subscription objects for reconnect
    this.intentionalClose = new Set(); // ids the user disconnect()'d
    this.reconnects = new ReconnectScheduler();
  }

  connect(subscription) {
    const { args, subscription_id } = subscription;
    const { message, event_type, endpoint_url, headers } = args;

    // Close existing connection for this subscription if any. We mark
    // it as intentional so the close handler doesn't immediately
    // schedule a reconnect against the URL we're about to replace.
    if (this.wsClients[subscription_id]) {
      this.intentionalClose.add(subscription_id);
      try {
        this.wsClients[subscription_id].close();
      } catch (err) {
        log.error(`Error closing existing WebSocket for subscription ID: ${subscription_id}`, err);
      }
      delete this.wsClients[subscription_id];
    }

    // Cache the subscription object so the reconnect path can rebuild
    // a fresh client without re-reading from Redis.
    this.subscriptions[subscription_id] = subscription;

    // Parse headers safely
    let parsedHeaders = {};
    if (headers) {
      try {
        parsedHeaders = typeof headers === 'object' ? headers : JSON.parse(headers);
      } catch (err) {
        log.error(`Failed to parse headers for subscription ID: ${subscription_id}`, err);
      }
    }

    // Create WebSocket client using ws
    let wsClient;
    try {
      wsClient = new WebSocket(endpoint_url, { headers: parsedHeaders });
    } catch (err) {
      // Constructor throws synchronously on bad URL — schedule a retry
      // anyway so a transient DNS/proxy hiccup doesn't strand the sub.
      log.error(`WebSocket constructor threw for ${subscription_id}:`, err.message);
      this._scheduleReconnect(subscription_id);
      return;
    }

    wsClient.on('open', () => {
      log.info(`WebSocket connection established for subscription ID: ${subscription_id}`);
      // Successful connect — clear any prior backoff so the next drop
      // starts the cycle from the base delay again.
      this.reconnects.reset(subscription_id);

      if (message) {
        log.info(`Sending subscription message for subscription ID: ${subscription_id}`);
        wsClient.send(JSON.stringify(message));
      }
    });

    wsClient.on('message', message => {
      const decodedMessage = message.toString();
      log.info(
        `WebSocket message received for subscription ID: ${subscription_id}`,
        decodedMessage
      );

      let parsedMessage;
      try {
        parsedMessage = JSON.parse(decodedMessage);
      } catch (error) {
        log.error(`Failed to parse message for subscription ID: ${subscription_id}`, error);
        return;
      }

      if (event_type && parsedMessage.event !== event_type) {
        log.info(
          `Event '${parsedMessage.event}' did not match expected '${event_type}' for subscription ID: ${subscription_id}`
        );
      } else {
        log.info(`Processing message for subscription ID: ${subscription_id}`);
        this.raiseConnectionEvent(subscription_id, parsedMessage);
      }
    });

    wsClient.on('close', (code, reason) => {
      log.info(`WebSocket connection closed for subscription ID: ${subscription_id}`, code, reason);
      // Drop our handle so a stale wsClient doesn't get reused.
      if (this.wsClients[subscription_id] === wsClient) {
        delete this.wsClients[subscription_id];
      }
      // If this was an intentional close (disconnect / connect-replace),
      // don't reconnect.
      if (this.intentionalClose.has(subscription_id)) {
        this.intentionalClose.delete(subscription_id);
        return;
      }
      this._scheduleReconnect(subscription_id);
    });

    wsClient.on('error', error => {
      log.error(`WebSocket connection error for subscription ID: ${subscription_id}`, error);
      // The 'close' event fires after 'error' from the ws library;
      // backoff is scheduled there.
    });

    this.wsClients[subscription_id] = wsClient;
  }

  /** Internal — reconnect using the cached subscription object. */
  _scheduleReconnect(subscriptionId) {
    const cached = this.subscriptions[subscriptionId];
    if (!cached) return;
    const delay = this.reconnects.schedule(subscriptionId, () => {
      log.info(
        `Reconnect attempt #${this.reconnects.attempts(subscriptionId)} for ${subscriptionId}`
      );
      this.connect(cached);
    });
    log.info(`Will reconnect ${subscriptionId} in ${delay}ms`);
  }

  disconnect(subscriptionId) {
    this.reconnects.stop(subscriptionId);
    delete this.subscriptions[subscriptionId];
    if (this.wsClients[subscriptionId]) {
      this.intentionalClose.add(subscriptionId);
      this.wsClients[subscriptionId].close();
      delete this.wsClients[subscriptionId];
      log.info(`WebSocket connection closed for subscription ID: ${subscriptionId}`);
    }
  }
}

module.exports = WebSocketHandler;
