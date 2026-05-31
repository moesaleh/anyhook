const WebSocket = require('ws');
const BaseHandler = require('./baseHandler');
const { createLogger } = require('../../lib/logger');
const { ReconnectScheduler } = require('../reconnect');
const { assertConnectAllowed, createSafeAgent, SsrfBlockedError } = require('../../lib/ssrf-guard');

const log = createLogger('websocket-handler');

// How long to wait for each upstream socket's close handshake during a
// graceful shutdown drain before giving up on that socket. Kept well under
// the connector's 10s force-exit budget so draining many sockets in
// parallel still finishes in time.
const DRAIN_CLOSE_TIMEOUT_MS = parseInt(process.env.WS_DRAIN_CLOSE_TIMEOUT_MS, 10) || 3000;

class WebSocketHandler extends BaseHandler {
  constructor(producer, redisClient) {
    super(producer, redisClient);
    this.wsClients = {}; // Track connections per subscription ID
    this.subscriptions = {}; // Cached subscription objects for reconnect
    this.intentionalClose = new Set(); // ids the user disconnect()'d
    this.reconnects = new ReconnectScheduler();
  }

  /** Upstream connections this handler currently holds. (P1-2 gauge / P2-17 drain) */
  activeCount() {
    return Object.keys(this.wsClients).length;
  }

  /**
   * IDs with a live socket OR a cached subscription (pending reconnect).
   * The connector uses this to reconcile partition ownership on a rebalance
   * and to drain on shutdown; a sub waiting on a backoff timer still "owns"
   * an upstream intent, so include it.
   */
  activeSubscriptionIds() {
    return Array.from(
      new Set([...Object.keys(this.wsClients), ...Object.keys(this.subscriptions)])
    );
  }

  async connect(subscription) {
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

    // SSRF guard (P0-4): resolve endpoint_url right before connecting and
    // reject if it currently resolves to a private/loopback/link-local/
    // CGNAT/IMDS address. This is the connect-time re-check that create-time
    // validation can't provide (DNS rebinding). On a block we refuse AND
    // stop reconnecting — pointing a subscription at an internal address is
    // a misconfiguration/attack, not a transient fault, so retrying would
    // just spin. Drop the cached subscription so _scheduleReconnect is a
    // no-op for it.
    let pinnedIp, family;
    try {
      ({ pinnedIp, family } = await assertConnectAllowed(endpoint_url));
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        log.error(
          `SSRF guard blocked endpoint for subscription ${subscription_id} (${err.reason}); refusing to connect`
        );
        this.reconnects.stop(subscription_id);
        delete this.subscriptions[subscription_id];
        return;
      }
      // Unexpected validation error — treat as transient and let the
      // existing reconnect machinery back off and retry.
      log.error(`Endpoint validation failed for subscription ${subscription_id}:`, err.message);
      this._scheduleReconnect(subscription_id);
      return;
    }
    const isHttps = /^wss:/i.test(endpoint_url);
    const pinnedAgent = createSafeAgent(pinnedIp, family, isHttps);

    // Parse headers safely
    let parsedHeaders = {};
    if (headers) {
      try {
        parsedHeaders = typeof headers === 'object' ? headers : JSON.parse(headers);
      } catch (err) {
        log.error(`Failed to parse message for subscription ID: ${subscription_id}`, err);
      }
    }

    // Create WebSocket client using ws. The pinned agent forces the dial to
    // the vetted public IP (re-checked on every connect) while keeping the
    // original hostname for TLS SNI / Host header.
    let wsClient;
    try {
      wsClient = new WebSocket(endpoint_url, { headers: parsedHeaders, agent: pinnedAgent });
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
      // Full payload at debug only — info-level logging of every inbound
      // frame is hot-path CPU and leaks source PII/secrets to central logs.
      // Lifecycle + counts stay at info. (P2-6)
      log.debug(
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
        log.debug(
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
      // connect() is async (SSRF resolve happens before the dial); the
      // timer can't await it, so swallow rejections here — any real
      // failure re-enters this path via the socket 'close' handler.
      Promise.resolve(this.connect(cached)).catch(err =>
        log.error(`Reconnect for ${subscriptionId} threw:`, err.message)
      );
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

  /**
   * Gracefully drain every upstream socket on shutdown (P2-17). For each
   * live socket we cancel any pending reconnect, mark the close intentional
   * (so the 'close' handler doesn't re-schedule), send the WebSocket close
   * handshake, and await the 'close' event up to DRAIN_CLOSE_TIMEOUT_MS
   * before falling back to terminate(). Runs BEFORE the connector
   * disconnects Kafka/Redis so sources see a clean close.
   */
  async closeAll() {
    const ids = this.activeSubscriptionIds();
    if (ids.length === 0) return;
    log.info(`[WebSocketHandler] - Draining ${ids.length} upstream connection(s)`);
    await Promise.allSettled(
      ids.map(id => {
        // Stop any backoff timer + forget the cached sub so nothing
        // re-opens this connection while we're shutting down.
        this.reconnects.stop(id);
        delete this.subscriptions[id];
        const ws = this.wsClients[id];
        delete this.wsClients[id];
        if (!ws) return Promise.resolve();
        this.intentionalClose.add(id);
        return new Promise(resolve => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            // Close handshake didn't complete in time — hard-kill the
            // socket so shutdown isn't held hostage by a half-open peer.
            try {
              ws.terminate();
            } catch {
              /* already gone */
            }
            done();
          }, DRAIN_CLOSE_TIMEOUT_MS);
          ws.once('close', done);
          try {
            ws.close();
          } catch {
            done();
          }
        });
      })
    );
  }
}

module.exports = WebSocketHandler;
