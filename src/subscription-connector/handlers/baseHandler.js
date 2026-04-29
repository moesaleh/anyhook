const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../../lib/logger');

const log = createLogger('connector-base');

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
   */
  raiseConnectionEvent(subscriptionId, data) {
    const eventId = uuidv4();
    this.producer
      .send({
        topic: 'connection_events',
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
