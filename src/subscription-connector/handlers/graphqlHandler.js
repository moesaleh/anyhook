const { createClient } = require('graphql-ws'); // New WebSocket client
const { WebSocket } = require('ws'); // Use ws WebSocket implementation for Node.js
const gql = require('graphql-tag');
const BaseHandler = require('./baseHandler');
const { createLogger } = require('../../lib/logger');

const log = createLogger('graphql-handler');

class GraphQLHandler extends BaseHandler {
  constructor(producer, redisClient) {
    super(producer, redisClient);
    this.activeSubscriptions = {}; // Track active subscriptions by ID
    this.wsClients = {}; // Store WebSocket client instances by subscription ID
  }

  async connect(subscription) {
    const { args, subscription_id } = subscription;
    const { query, endpoint_url, headers } = args;

    // Defensive close: connect() can be re-invoked for the same
    // subscription_id by a Kafka redelivery (consumer rebalance, pod
    // restart before commit) or by an update_events handler. Without
    // this, the previous wsClient + subscribe handle become orphaned —
    // their TCP connection stays open, the source keeps streaming into
    // a closure that publishes to connection_events, and we get
    // duplicate webhook deliveries until the orphaned socket dies.
    // WebSocketHandler already does this; aligning behaviour here.
    if (this.activeSubscriptions[subscription_id] || this.wsClients[subscription_id]) {
      log.info(
        `[GraphQLHandler] - connect() called for already-tracked subscription ${subscription_id}; closing existing client first`
      );
      try {
        this.disconnect(subscription_id);
      } catch (err) {
        log.error(
          `[GraphQLHandler] - Defensive disconnect failed for ${subscription_id}:`,
          err.message
        );
      }
    }

    log.info(`[GraphQLHandler] - Connecting to WebSocket for subscription ID: ${subscription_id}`);
    log.info(`[GraphQLHandler] - Endpoint URL: ${endpoint_url}`);
    log.info(`[GraphQLHandler] - GraphQL Query: ${query}`);

    // Parse headers safely
    let parsedHeaders = {};
    if (headers) {
      try {
        parsedHeaders = typeof headers === 'object' ? headers : JSON.parse(headers);
      } catch (err) {
        log.error(
          `[GraphQLHandler] - Failed to parse headers for subscription ID: ${subscription_id}`,
          err
        );
      }
    }

    try {
      // Create a WebSocket client using graphql-ws.
      //
      // Reconnect policy: we hand graphql-ws's built-in machinery a
      // very large retryAttempts and an exponential-backoff retryWait
      // so it never gives up on its own. The user-driven cancellation
      // path is wsClient.dispose() in disconnect(), which the library
      // honors and stops scheduling further attempts.
      //
      // Why not roll our own like WebSocketHandler? graphql-ws already
      // re-executes the subscribe() handle across reconnects, so a
      // subscribe-once-and-forget caller (us) keeps receiving events
      // after a transient drop without us re-issuing the GraphQL
      // subscription on every reconnect.
      const wsClient = createClient({
        url: endpoint_url,
        webSocketImpl: WebSocket,
        retryAttempts: Number.MAX_SAFE_INTEGER,
        shouldRetry: () => true,
        retryWait: async retries => {
          // 1s -> 2s -> 4s -> ... capped at 60s, ±25% jitter so flapping
          // sources don't all reconnect in lockstep.
          const exp = Math.min(60_000, 1000 * 2 ** Math.max(0, retries));
          const jitter = exp * (Math.random() * 0.5 - 0.25);
          const delay = Math.max(1000, Math.floor(exp + jitter));
          await new Promise(r => setTimeout(r, delay));
        },
        connectionParams: {
          headers: parsedHeaders,
        },
      });

      wsClient.on('connecting', () =>
        log.info(`[GraphQLHandler] - connecting (subscription ${subscription_id})`)
      );
      wsClient.on('connected', () =>
        log.info(`[GraphQLHandler] - connected (subscription ${subscription_id})`)
      );
      wsClient.on('closed', () =>
        log.info(`[GraphQLHandler] - closed (subscription ${subscription_id})`)
      );
      wsClient.on('error', error =>
        log.error(`[GraphQLHandler] - error on ${subscription_id}:`, error.message || error)
      );

      // Execute the subscription query
      const subscriptionQuery = gql`
        ${query}
      `;
      const unsubscribe = wsClient.subscribe(
        {
          query: subscriptionQuery.loc.source.body,
        },
        {
          next: data => {
            log.info(
              `[GraphQLHandler] - New data received for subscription ID: ${subscription_id}`,
              JSON.stringify(data)
            );

            // Raise event for processing
            log.info(`Processing message for subscription ID: ${subscription_id}`);
            this.raiseConnectionEvent(subscription_id, data);
          },
          error: err => {
            log.error(
              `[GraphQLHandler] - Subscription error for subscription ID: ${subscription_id}`,
              err
            );
          },
          complete: () => {
            log.info(
              `[GraphQLHandler] - Subscription completed for subscription ID: ${subscription_id}`
            );
          },
        }
      );

      // Store the unsubscribe function for later cleanup
      this.activeSubscriptions[subscription_id] = unsubscribe;
      this.wsClients[subscription_id] = wsClient;
    } catch (err) {
      log.error(
        `[GraphQLHandler] - Error connecting WebSocket for subscription ID: ${subscription_id}`,
        err
      );
    }
  }

  disconnect(subscriptionId) {
    log.info(`[GraphQLHandler] - Disconnecting subscription for ID: ${subscriptionId}`);

    // Unsubscribe from active subscription
    if (this.activeSubscriptions[subscriptionId]) {
      this.activeSubscriptions[subscriptionId]();
      delete this.activeSubscriptions[subscriptionId];
      log.info(`[GraphQLHandler] - Unsubscribed from subscription ID: ${subscriptionId}`);
    }

    // Close WebSocket connection
    if (this.wsClients[subscriptionId]) {
      this.wsClients[subscriptionId].dispose();
      delete this.wsClients[subscriptionId];
      log.info(
        `[GraphQLHandler] - WebSocket connection closed for subscription ID: ${subscriptionId}`
      );
    }
  }
}

module.exports = GraphQLHandler;
