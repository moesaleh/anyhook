const { createClient } = require('graphql-ws'); // New WebSocket client
const { WebSocket } = require('ws'); // Use ws WebSocket implementation for Node.js
const gql = require('graphql-tag');
const BaseHandler = require('./baseHandler');
const { createLogger } = require('../../lib/logger');
const { assertConnectAllowed, createSafeAgent, SsrfBlockedError } = require('../../lib/ssrf-guard');

const log = createLogger('graphql-handler');

class GraphQLHandler extends BaseHandler {
  constructor(producer, redisClient) {
    super(producer, redisClient);
    this.activeSubscriptions = {}; // Track active subscriptions by ID
    this.wsClients = {}; // Store WebSocket client instances by subscription ID
  }

  /** Upstream connections this handler currently holds. (P1-2 gauge / P2-17 drain) */
  activeCount() {
    return Object.keys(this.wsClients).length;
  }

  activeSubscriptionIds() {
    return Object.keys(this.wsClients);
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

    // SSRF guard (P0-4): resolve endpoint_url right before connecting and
    // reject if it currently points at a private / loopback / link-local /
    // CGNAT / IMDS address. Create-time validation alone is defeated by DNS
    // rebinding; this is the connect-time re-check. We also pin the socket
    // to the vetted public IP via a custom ws agent so the actual dial
    // can't be re-pointed in the TOCTOU window. Refuse (don't reconnect)
    // on a block — a subscription aimed at an internal address is a
    // misconfiguration/attack, not a transient fault.
    let pinnedIp, family;
    try {
      ({ pinnedIp, family } = await assertConnectAllowed(endpoint_url));
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        log.error(
          `[GraphQLHandler] - SSRF guard blocked endpoint for subscription ${subscription_id} (${err.reason}); refusing to connect`
        );
        return;
      }
      log.error(
        `[GraphQLHandler] - Endpoint validation failed for subscription ${subscription_id}:`,
        err.message
      );
      return;
    }
    const isHttps = /^wss:/i.test(endpoint_url);
    const pinnedAgent = createSafeAgent(pinnedIp, family, isHttps);

    log.info(`[GraphQLHandler] - Connecting to WebSocket for subscription ID: ${subscription_id}`);
    log.debug(`[GraphQLHandler] - Endpoint URL: ${endpoint_url}`);
    log.debug(`[GraphQLHandler] - GraphQL Query: ${query}`);

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

    // ws WebSocket subclass that injects the SSRF-safe pinned agent. graphql-ws
    // instantiates the impl as `new WebSocketImpl(url, protocol)` (no options
    // arg), so we capture the agent here and force it into ws's options. The
    // agent's pinned lookup re-checks the IP is public on every dial, so it
    // stays safe across graphql-ws's internal reconnects. SNI/Host/cert still
    // use the original hostname.
    class PinnedWebSocket extends WebSocket {
      constructor(address, protocols) {
        super(address, protocols, { agent: pinnedAgent, headers: parsedHeaders });
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
        webSocketImpl: PinnedWebSocket,
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
            // Full payload at debug only — info-level JSON.stringify of every
            // 'next' is hot-path CPU and leaks source PII/secrets to central
            // logs. Keep the per-message lifecycle marker at info. (P2-6)
            log.debug(
              `[GraphQLHandler] - New data received for subscription ID: ${subscription_id}`,
              JSON.stringify(data)
            );
            log.info(`Processing message for subscription ID: ${subscription_id}`);

            // Raise event for processing
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

  /**
   * Gracefully close every graphql-ws client. dispose() returns a promise
   * that resolves once the client has sent its close frame and torn down
   * the socket; awaiting them (within the shutdown force-exit budget) means
   * upstream sources see a clean close instead of a dropped TCP. (P2-17)
   */
  async closeAll() {
    const ids = this.activeSubscriptionIds();
    if (ids.length === 0) return;
    log.info(`[GraphQLHandler] - Draining ${ids.length} upstream connection(s)`);
    await Promise.allSettled(
      ids.map(async id => {
        // Stop re-delivering events first.
        if (this.activeSubscriptions[id]) {
          try {
            this.activeSubscriptions[id]();
          } catch (err) {
            log.error(`[GraphQLHandler] - drain unsubscribe failed for ${id}:`, err.message);
          }
          delete this.activeSubscriptions[id];
        }
        const client = this.wsClients[id];
        delete this.wsClients[id];
        if (!client) return;
        try {
          // dispose() may return a promise (graphql-ws lazy:false) or void.
          await client.dispose();
        } catch (err) {
          log.error(`[GraphQLHandler] - drain dispose failed for ${id}:`, err.message);
        }
      })
    );
  }
}

module.exports = GraphQLHandler;
