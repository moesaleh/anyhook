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
        console.log(`Disconnected subscription ${subscriptionId}`);
    }

    /**
     * Publish a connection event for the webhook-dispatcher to deliver.
     * Fire-and-forget on the network side, but the kafkajs producer awaits
     * the broker ack internally. Errors are logged but not thrown — the
     * upstream connection should keep running even if a single publish
     * fails. Caller (handler subclass) shouldn't block on this.
     */
    raiseConnectionEvent(subscriptionId, data) {
        this.producer
            .send({
                topic: 'connection_events',
                messages: [{ value: JSON.stringify({ subscriptionId, data }) }],
            })
            .catch((err) => {
                console.error(`Error sending to connection_events topic for ${subscriptionId}`, err.message);
            });
    }
}

module.exports = BaseHandler;
