class BaseHandler {
    constructor(producer, redisClient) {
        this.producer = producer;
        this.redisClient = redisClient;
    }

    connect(subscription) {
        throw new Error('connect() must be implemented by subclass');
    }

    disconnect(subscriptionId) {
        console.log(`Disconnected subscription ${subscriptionId}`);
    }

    raiseConnectionEvent(subscriptionId, data) {
        const payloads = [{ topic: 'connection_events', messages: JSON.stringify({ subscriptionId, data }) }];
        this.producer.send(payloads, (err, data) => {
            if (err) console.error('Error sending to connection_events topic', err);
        });
    }
}

module.exports = BaseHandler;
