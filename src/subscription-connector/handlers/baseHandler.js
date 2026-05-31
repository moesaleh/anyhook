const { v4: uuidv4 } = require('uuid');
const { CompressionTypes } = require('kafkajs');
const { createLogger } = require('../../lib/logger');

const log = createLogger('connector-base');

// Connection-event producer compression. The connection_events topic
// carries the full source payload as JSON — repetitive, highly
// compressible, and the hottest producer path in the connector. Default
// to gzip (always available in kafkajs core); operators can pick lz4 /
// snappy / zstd via env, or 'none' to disable. Unknown values fall back
// to gzip with a warning so a typo can't silently send uncompressed.
// (P2-15)
function resolveCompression(envValue) {
  const name = String(envValue || 'gzip')
    .trim()
    .toLowerCase();
  switch (name) {
    case 'none':
      return CompressionTypes.None;
    case 'gzip':
      return CompressionTypes.GZIP;
    case 'snappy':
      return CompressionTypes.Snappy;
    case 'lz4':
      return CompressionTypes.LZ4;
    case 'zstd':
      return CompressionTypes.ZSTD;
    default:
      log.warn(`Unknown KAFKA_COMPRESSION '${envValue}', defaulting to gzip`);
      return CompressionTypes.GZIP;
  }
}

const CONNECTION_EVENT_COMPRESSION = resolveCompression(process.env.KAFKA_COMPRESSION);

class BaseHandler {
  constructor(producer, redisClient) {
    this.producer = producer;
    this.redisClient = redisClient;
  }

  // eslint-disable-next-line no-unused-vars
  connect(subscription) {
    throw new Error('connect() must be implemented by subclass');
  }

  disconnect(subscriptionId) {
    log.info(`Disconnected subscription ${subscriptionId}`);
  }

  /**
   * Number of upstream connections this handler is currently holding open.
   * Subclasses that actually track sockets override this; the base returns
   * 0 so callers (open-connection gauge, shutdown drain) can sum across all
   * handlers uniformly without type checks.
   */
  activeCount() {
    return 0;
  }

  /**
   * The subscription IDs this handler currently has connections (or pending
   * reconnects) for. Used by the connector to reconcile ownership on a
   * Kafka rebalance and to drain on shutdown. Base returns [] so the
   * reconcile/drain loops are handler-agnostic.
   */
  activeSubscriptionIds() {
    return [];
  }

  /**
   * Gracefully close every upstream connection this handler holds. Default
   * implementation tears down each tracked subscription via the subclass's
   * own disconnect(); subclasses with async close frames (ws / graphql-ws)
   * override to await them. Returns when all closes have been issued.
   *
   * Shutdown calls this BEFORE disconnecting Kafka/Redis so upstream sockets
   * get a real close instead of being abandoned to the 10s force-exit.
   * (P2-17)
   */
  async closeAll() {
    for (const id of this.activeSubscriptionIds()) {
      try {
        this.disconnect(id);
      } catch (err) {
        log.error(`closeAll: disconnect failed for ${id}:`, err.message);
      }
    }
  }

  /**
   * Publish a connection event for the webhook-dispatcher to deliver.
   * Fire-and-forget on the network side, but the kafkajs producer awaits
   * the broker ack internally. Errors are logged but not thrown — the
   * upstream connection should keep running even if a single publish
   * fails. Caller (handler subclass) shouldn't block on this.
   *
   * eventId is generated HERE (producer-side) so that a Kafka rebalance
   * or dispatcher restart re-processing the same message reuses the
   * same event_id. The dispatcher's idempotency check then skips the
   * duplicate webhook delivery instead of producing two parallel chains
   * of (initial + retries) for the same source data.
   *
   * Compression is enabled (env KAFKA_COMPRESSION, default gzip) — the
   * payload is repetitive JSON and this is the hot producer path. We don't
   * await the send so a single source's event stream isn't gated on the
   * broker ack in lockstep; the producer batches concurrent sends from
   * many subscriptions under the hood. (P2-15)
   */
  raiseConnectionEvent(subscriptionId, data) {
    const eventId = uuidv4();
    this.producer
      .send({
        topic: 'connection_events',
        compression: CONNECTION_EVENT_COMPRESSION,
        // key=subscriptionId pins all events for one subscription to a
        // single partition → same dispatcher pod handles them in order,
        // preserving delivery sequence for any given source.
        messages: [
          { key: subscriptionId, value: JSON.stringify({ subscriptionId, eventId, data }) },
        ],
      })
      .catch(err => {
        log.error(`Error sending to connection_events topic for ${subscriptionId}`, err.message);
      });
  }
}

module.exports = BaseHandler;
module.exports.resolveCompression = resolveCompression;
