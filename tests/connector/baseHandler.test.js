/**
 * Unit tests for BaseHandler (P1-6, connector half).
 *
 * The single most load-bearing contract here is raiseConnectionEvent: it
 * generates the `eventId` that the webhook-dispatcher's idempotency check keys
 * on. If two handler instances (or a redelivery) raised events with different
 * ids for the same source data, the dispatcher would fire duplicate webhook
 * chains. We assert the published envelope shape, a fresh UUID per call, the
 * subscription-keyed partition pin, and that a producer.send rejection is
 * swallowed (a single failed publish must not kill the upstream connection).
 *
 * Also covers the default activeCount/activeSubscriptionIds/closeAll the
 * connector's reconcile + shutdown loops call uniformly across handler types,
 * and the KAFKA_COMPRESSION resolver.
 */

const { CompressionTypes } = require('kafkajs');
const BaseHandler = require('../../src/subscription-connector/handlers/baseHandler');
const { resolveCompression } = require('../../src/subscription-connector/handlers/baseHandler');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeProducer(sendImpl) {
  return { send: jest.fn(sendImpl || (() => Promise.resolve())) };
}

describe('raiseConnectionEvent', () => {
  it('publishes a {subscriptionId, eventId, data} envelope to connection_events', () => {
    const producer = makeProducer();
    const handler = new BaseHandler(producer, {});

    handler.raiseConnectionEvent('sub-42', { hello: 'world' });

    expect(producer.send).toHaveBeenCalledTimes(1);
    const arg = producer.send.mock.calls[0][0];
    expect(arg.topic).toBe('connection_events');
    expect(arg.messages).toHaveLength(1);

    const message = arg.messages[0];
    // key=subscriptionId pins all of one sub's events to a single partition so
    // one dispatcher pod handles them in order.
    expect(message.key).toBe('sub-42');

    const value = JSON.parse(message.value);
    expect(value.subscriptionId).toBe('sub-42');
    expect(value.data).toEqual({ hello: 'world' });
    expect(value.eventId).toMatch(UUID_RE);
  });

  it('generates a fresh eventId on every call (idempotency key is unique per event)', () => {
    const producer = makeProducer();
    const handler = new BaseHandler(producer, {});

    handler.raiseConnectionEvent('sub-1', { n: 1 });
    handler.raiseConnectionEvent('sub-1', { n: 2 });

    const id1 = JSON.parse(producer.send.mock.calls[0][0].messages[0].value).eventId;
    const id2 = JSON.parse(producer.send.mock.calls[1][0].messages[0].value).eventId;
    expect(id1).not.toBe(id2);
  });

  it('sets a compression type on the publish (default gzip)', () => {
    const producer = makeProducer();
    const handler = new BaseHandler(producer, {});
    handler.raiseConnectionEvent('sub-1', { n: 1 });
    const arg = producer.send.mock.calls[0][0];
    // Compression is resolved at module load from env (default gzip). Just
    // assert the field is present + a known kafkajs compression code.
    expect(Object.values(CompressionTypes)).toContain(arg.compression);
  });

  it('swallows a producer.send rejection so the upstream connection survives', async () => {
    const producer = makeProducer(() => Promise.reject(new Error('broker down')));
    const handler = new BaseHandler(producer, {});

    // Must not throw synchronously...
    expect(() => handler.raiseConnectionEvent('sub-1', { n: 1 })).not.toThrow();
    // ...and the rejected send must not surface as an unhandled rejection.
    await new Promise(r => setImmediate(r));
    expect(producer.send).toHaveBeenCalledTimes(1);
  });
});

describe('default handler surface (used by reconcile + shutdown drains)', () => {
  it('connect() throws — subclasses must implement it', () => {
    const handler = new BaseHandler(makeProducer(), {});
    expect(() => handler.connect({})).toThrow(/must be implemented/i);
  });

  it('activeCount()/activeSubscriptionIds() default to 0/[] so loops are type-agnostic', () => {
    const handler = new BaseHandler(makeProducer(), {});
    expect(handler.activeCount()).toBe(0);
    expect(handler.activeSubscriptionIds()).toEqual([]);
  });

  it('closeAll() disconnects every tracked id via the subclass disconnect()', async () => {
    const handler = new BaseHandler(makeProducer(), {});
    handler.activeSubscriptionIds = () => ['a', 'b', 'c'];
    const disconnect = jest.spyOn(handler, 'disconnect');

    await handler.closeAll();

    expect(disconnect).toHaveBeenCalledWith('a');
    expect(disconnect).toHaveBeenCalledWith('b');
    expect(disconnect).toHaveBeenCalledWith('c');
  });

  it('closeAll() keeps going even if one disconnect throws', async () => {
    const handler = new BaseHandler(makeProducer(), {});
    handler.activeSubscriptionIds = () => ['a', 'b'];
    jest.spyOn(handler, 'disconnect').mockImplementation(id => {
      if (id === 'a') throw new Error('close failed');
    });

    await expect(handler.closeAll()).resolves.toBeUndefined();
    expect(handler.disconnect).toHaveBeenCalledWith('b');
  });
});

describe('resolveCompression (P2-15)', () => {
  it.each([
    ['none', CompressionTypes.None],
    ['gzip', CompressionTypes.GZIP],
    ['GZIP', CompressionTypes.GZIP],
    ['  gzip  ', CompressionTypes.GZIP],
  ])('resolves %j to the matching kafkajs code', (input, expected) => {
    expect(resolveCompression(input)).toBe(expected);
  });

  it('defaults an empty/undefined value to gzip', () => {
    expect(resolveCompression(undefined)).toBe(CompressionTypes.GZIP);
    expect(resolveCompression('')).toBe(CompressionTypes.GZIP);
  });

  it('falls back to gzip on an unknown value rather than sending uncompressed', () => {
    expect(resolveCompression('bogus')).toBe(CompressionTypes.GZIP);
  });
});
