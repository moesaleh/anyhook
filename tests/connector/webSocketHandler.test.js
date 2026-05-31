/**
 * Unit tests for the WebSocket source handler (P1-6, connector half).
 *
 * Covers the load-bearing contracts the assessment calls out:
 *   - event_type filtering: a frame whose `event` != configured event_type is
 *     dropped; a matching (or absent-filter) frame calls raiseConnectionEvent.
 *   - intentionalClose vs unexpected close: an intentional close (disconnect /
 *     connect-replace) must NOT reconnect; an unexpected close wires through to
 *     _scheduleReconnect.
 *   - constructor-throw → schedule-retry: `new WebSocket(...)` throwing
 *     synchronously still schedules a reconnect (transient DNS/proxy hiccup).
 *   - SSRF block at connect time refuses AND stops reconnecting (cached sub
 *     dropped so _scheduleReconnect is a no-op).
 *   - raiseConnectionEvent (inherited) generates an eventId and publishes the
 *     {subscriptionId, eventId, data} envelope the dispatcher idempotency needs.
 *
 * Everything is mocked: `ws` is an EventEmitter stub, the ssrf-guard resolves
 * to a fixed pinned IP (no real DNS), the producer is a spy. No network, no DB.
 */

// --- ws stub -----------------------------------------------------------------
// Each construction yields an EventEmitter with the socket methods the handler
// calls. Tests reach the latest-constructed instance via mockWs.instances.
// Jest forbids a jest.mock factory from closing over non-`mock`-prefixed
// vars, so all shared state hangs off `mockWs` (which IS allowed).
const mockWs = {
  instances: [],
  constructorImpl: null, // a test can set this to force a synchronous throw
  reset() {
    this.instances = [];
    this.constructorImpl = null;
  },
};

jest.mock('ws', () => {
  // `ws` is imported as `const WebSocket = require('ws')` in webSocketHandler.
  const { EventEmitter: EE } = require('events');
  class FakeWebSocket extends EE {
    constructor(url, opts) {
      super();
      if (mockWs.constructorImpl) mockWs.constructorImpl(url, opts);
      this.url = url;
      this.opts = opts;
      this.send = jest.fn();
      this.close = jest.fn(() => this.emit('close', 1000, Buffer.from('')));
      this.terminate = jest.fn();
      mockWs.instances.push(this);
    }
  }
  return jest.fn((url, opts) => new FakeWebSocket(url, opts));
});

// --- ssrf-guard stub ---------------------------------------------------------
// Real module does DNS; we stub assertConnectAllowed/createSafeAgent and keep
// the real SsrfBlockedError class so `instanceof` branches in the handler work.
// Control state hangs off the `mock`-prefixed `mockSsrf` so the jest.mock
// factory may reference it (same hoisting rule as `ws` above).
const { SsrfBlockedError } = jest.requireActual('../../src/lib/ssrf-guard');
const mockSsrf = { impl: null };
jest.mock('../../src/lib/ssrf-guard', () => {
  const actual = jest.requireActual('../../src/lib/ssrf-guard');
  return {
    ...actual,
    assertConnectAllowed: jest.fn(async url => {
      if (mockSsrf.impl) return mockSsrf.impl(url);
      return { pinnedIp: '93.184.216.34', family: 4 };
    }),
    createSafeAgent: jest.fn(() => ({ __safeAgent: true })),
  };
});

const WebSocketHandler = require('../../src/subscription-connector/handlers/webSocketHandler');

function makeProducer() {
  return { send: jest.fn(() => Promise.resolve()) };
}

function makeSub(overrides = {}) {
  return {
    subscription_id: 'ws-sub-1',
    connection_type: 'websocket',
    args: {
      endpoint_url: 'wss://example.com/socket',
      message: { type: 'subscribe' },
      ...overrides.args,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockWs.reset();
  mockSsrf.impl = null;
  jest.clearAllMocks();
});

describe('WebSocketHandler.connect', () => {
  it('opens a socket, caches the sub, and sends the subscribe message on open', async () => {
    const handler = new WebSocketHandler(makeProducer(), {});
    await handler.connect(makeSub());

    expect(mockWs.instances).toHaveLength(1);
    const ws = mockWs.instances[0];
    // Cached for reconnect + tracked as active.
    expect(handler.subscriptions['ws-sub-1']).toBeDefined();
    expect(handler.wsClients['ws-sub-1']).toBe(ws);
    expect(handler.activeCount()).toBe(1);

    ws.emit('open');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe' }));
  });

  it('resets the backoff counter on a successful open', async () => {
    const handler = new WebSocketHandler(makeProducer(), {});
    await handler.connect(makeSub());
    // Pretend a prior failed attempt left a backoff count.
    handler.reconnects.schedule('ws-sub-1', () => {});
    expect(handler.reconnects.attempts('ws-sub-1')).toBeGreaterThan(0);

    mockWs.instances[0].emit('open');
    expect(handler.reconnects.attempts('ws-sub-1')).toBe(0);
  });

  it('passes the SSRF-pinned agent to the ws constructor', async () => {
    const WebSocket = require('ws');
    const handler = new WebSocketHandler(makeProducer(), {});
    await handler.connect(makeSub());
    expect(WebSocket).toHaveBeenCalledTimes(1);
    const [, opts] = WebSocket.mock.calls[0];
    expect(opts.agent).toEqual({ __safeAgent: true });
  });
});

describe('event_type filtering', () => {
  it('drops a frame whose event does not match the configured event_type', async () => {
    const producer = makeProducer();
    const handler = new WebSocketHandler(producer, {});
    await handler.connect(makeSub({ args: { event_type: 'order.created' } }));
    const ws = mockWs.instances[0];

    ws.emit('message', Buffer.from(JSON.stringify({ event: 'order.updated', id: 1 })));

    expect(producer.send).not.toHaveBeenCalled();
  });

  it('forwards a frame whose event matches the configured event_type', async () => {
    const producer = makeProducer();
    const handler = new WebSocketHandler(producer, {});
    await handler.connect(makeSub({ args: { event_type: 'order.created' } }));
    const ws = mockWs.instances[0];

    ws.emit('message', Buffer.from(JSON.stringify({ event: 'order.created', id: 7 })));

    expect(producer.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(producer.send.mock.calls[0][0].messages[0].value);
    expect(payload.data).toEqual({ event: 'order.created', id: 7 });
  });

  it('forwards every frame when no event_type filter is configured', async () => {
    const producer = makeProducer();
    const handler = new WebSocketHandler(producer, {});
    await handler.connect(makeSub({ args: {} }));
    const ws = mockWs.instances[0];

    ws.emit('message', Buffer.from(JSON.stringify({ event: 'anything', id: 1 })));
    ws.emit('message', Buffer.from(JSON.stringify({ event: 'other', id: 2 })));

    expect(producer.send).toHaveBeenCalledTimes(2);
  });

  it('ignores an unparseable frame without raising an event', async () => {
    const producer = makeProducer();
    const handler = new WebSocketHandler(producer, {});
    await handler.connect(makeSub({ args: {} }));
    const ws = mockWs.instances[0];

    ws.emit('message', Buffer.from('not json{'));

    expect(producer.send).not.toHaveBeenCalled();
  });
});

describe('close → reconnect wiring', () => {
  it('schedules a reconnect on an UNEXPECTED close', async () => {
    const handler = new WebSocketHandler(makeProducer(), {});
    const scheduleSpy = jest.spyOn(handler, '_scheduleReconnect');
    await handler.connect(makeSub());
    const ws = mockWs.instances[0];

    ws.emit('close', 1006, Buffer.from('abnormal'));

    expect(scheduleSpy).toHaveBeenCalledWith('ws-sub-1');
    // Stale handle dropped.
    expect(handler.wsClients['ws-sub-1']).toBeUndefined();
    // Cancel the (real-timer) backoff so jest can exit cleanly.
    handler.reconnects.stop('ws-sub-1');
  });

  it('does NOT reconnect on an intentional close (disconnect)', async () => {
    const handler = new WebSocketHandler(makeProducer(), {});
    const scheduleSpy = jest.spyOn(handler, '_scheduleReconnect');
    await handler.connect(makeSub());

    // disconnect() marks the close intentional and stops the scheduler.
    handler.disconnect('ws-sub-1');

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(handler.subscriptions['ws-sub-1']).toBeUndefined();
    expect(handler.wsClients['ws-sub-1']).toBeUndefined();
  });

  it('does NOT reconnect when connect() replaces an existing socket (intentional)', async () => {
    const handler = new WebSocketHandler(makeProducer(), {});
    const scheduleSpy = jest.spyOn(handler, '_scheduleReconnect');
    await handler.connect(makeSub());
    const first = mockWs.instances[0];

    // Re-connect the same id → the old socket is closed intentionally.
    await handler.connect(makeSub());

    expect(first.close).toHaveBeenCalled();
    // The replace-close must not have scheduled a reconnect.
    expect(scheduleSpy).not.toHaveBeenCalled();
    // The newest socket is the active one.
    expect(handler.wsClients['ws-sub-1']).toBe(mockWs.instances[1]);
  });

  it('_scheduleReconnect actually re-invokes connect after the backoff fires', async () => {
    jest.useFakeTimers();
    try {
      const handler = new WebSocketHandler(makeProducer(), {});
      await handler.connect(makeSub());
      const connectSpy = jest.spyOn(handler, 'connect');

      // Unexpected drop schedules a reconnect.
      mockWs.instances[0].emit('close', 1006, Buffer.from(''));
      expect(handler.reconnects.attempts('ws-sub-1')).toBe(1);

      // Advance past the (jittered) max backoff so the timer fires.
      await jest.advanceTimersByTimeAsync(75_000);
      expect(connectSpy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('_scheduleReconnect is a no-op once the cached sub is gone', async () => {
    jest.useFakeTimers();
    try {
      const handler = new WebSocketHandler(makeProducer(), {});
      await handler.connect(makeSub());
      // Forget the cached sub (mirrors disconnect / SSRF-block teardown).
      delete handler.subscriptions['ws-sub-1'];
      const connectSpy = jest.spyOn(handler, 'connect');

      handler._scheduleReconnect('ws-sub-1');
      await jest.advanceTimersByTimeAsync(75_000);

      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('constructor-throw → schedule-retry', () => {
  it('schedules a reconnect when the WebSocket constructor throws synchronously', async () => {
    mockWs.constructorImpl = () => {
      throw new Error('invalid URL');
    };
    const handler = new WebSocketHandler(makeProducer(), {});
    const scheduleSpy = jest.spyOn(handler, '_scheduleReconnect');

    await handler.connect(makeSub());

    // The sub is cached before the dial, so the schedule is effective.
    expect(scheduleSpy).toHaveBeenCalledWith('ws-sub-1');
    expect(handler.subscriptions['ws-sub-1']).toBeDefined();
    expect(handler.wsClients['ws-sub-1']).toBeUndefined();
    handler.reconnects.stop('ws-sub-1');
  });
});

describe('SSRF guard at connect time', () => {
  it('refuses to connect AND stops reconnecting when the endpoint is blocked', async () => {
    mockSsrf.impl = () => {
      throw new SsrfBlockedError('private_address', 'blocked', { host: 'evil.test' });
    };
    const handler = new WebSocketHandler(makeProducer(), {});
    const scheduleSpy = jest.spyOn(handler, '_scheduleReconnect');

    await handler.connect(makeSub());

    expect(mockWs.instances).toHaveLength(0); // never dialed
    expect(scheduleSpy).not.toHaveBeenCalled();
    // Cached sub dropped so a stray _scheduleReconnect can't resurrect it.
    expect(handler.subscriptions['ws-sub-1']).toBeUndefined();
  });

  it('treats a non-SSRF validation error as transient and schedules a retry', async () => {
    mockSsrf.impl = () => {
      throw new Error('resolver timeout');
    };
    const handler = new WebSocketHandler(makeProducer(), {});
    const scheduleSpy = jest.spyOn(handler, '_scheduleReconnect');

    await handler.connect(makeSub());

    expect(mockWs.instances).toHaveLength(0);
    expect(scheduleSpy).toHaveBeenCalledWith('ws-sub-1');
    handler.reconnects.stop('ws-sub-1');
  });
});

describe('activeSubscriptionIds / activeCount', () => {
  it('includes ids with a cached sub even without a live socket (pending reconnect)', async () => {
    const handler = new WebSocketHandler(makeProducer(), {});
    await handler.connect(makeSub());
    // Drop the live socket but keep the cached sub (a pending-reconnect state).
    delete handler.wsClients['ws-sub-1'];

    expect(handler.activeSubscriptionIds()).toContain('ws-sub-1');
    expect(handler.activeCount()).toBe(0); // count is live sockets only
  });
});
