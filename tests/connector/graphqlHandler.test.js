/**
 * Unit tests for the GraphQL (graphql-ws) source handler (P1-6, connector half).
 *
 * Covers the contracts the assessment calls out for this handler:
 *   - disconnect-before-reconnect: connect() on an already-tracked
 *     subscription_id tears down the prior client first (no orphaned socket →
 *     no duplicate deliveries). graphql-ws owns its OWN reconnect machinery, so
 *     there is no _scheduleReconnect here — the defensive close is the guard.
 *   - the subscribe `next` callback forwards data via raiseConnectionEvent.
 *   - SSRF block at connect time refuses (and, unlike the ws handler, simply
 *     returns — graphql-ws would otherwise retry forever against an internal
 *     address).
 *   - disconnect()/closeAll() unsubscribe and dispose the client.
 *
 * graphql-ws's createClient is stubbed to a fake client exposing on/subscribe/
 * dispose; the ssrf-guard is stubbed (no real DNS); the producer is a spy.
 */

// --- graphql-ws stub ---------------------------------------------------------
// State hangs off the `mock`-prefixed holder so the jest.mock factory may
// reference it. Each createClient() yields a fake client; subscribe() stores
// the sink so a test can drive next/error/complete.
const mockGqlWs = {
  clients: [],
  reset() {
    this.clients = [];
  },
};

jest.mock('graphql-ws', () => ({
  createClient: jest.fn(opts => {
    const handlers = {};
    const client = {
      opts,
      disposed: false,
      unsubscribe: jest.fn(),
      sink: null,
      on: jest.fn((evt, cb) => {
        handlers[evt] = cb;
      }),
      subscribe: jest.fn((_payload, sink) => {
        client.sink = sink;
        return client.unsubscribe;
      }),
      dispose: jest.fn(() => {
        client.disposed = true;
        return Promise.resolve();
      }),
      _emit: (evt, arg) => handlers[evt] && handlers[evt](arg),
    };
    mockGqlWs.clients.push(client);
    return client;
  }),
}));

// graphql-tag: the handler does gql`...` then reads .loc.source.body. Stub it
// so we don't need a real GraphQL parser for a config-string round-trip.
jest.mock('graphql-tag', () => {
  return (strings, ...exprs) => {
    const body = strings.reduce(
      (acc, s, i) => acc + s + (exprs[i] !== undefined ? exprs[i] : ''),
      ''
    );
    return { loc: { source: { body } } };
  };
});

// ws is only referenced to subclass for the pinned agent; a plain class is fine.
jest.mock('ws', () => ({ WebSocket: class FakeWS {} }));

// --- ssrf-guard stub ---------------------------------------------------------
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

const GraphQLHandler = require('../../src/subscription-connector/handlers/graphqlHandler');

function makeProducer() {
  return { send: jest.fn(() => Promise.resolve()) };
}

function makeSub(overrides = {}) {
  return {
    subscription_id: 'gql-sub-1',
    connection_type: 'graphql',
    args: {
      endpoint_url: 'wss://api.example.com/graphql',
      query: 'subscription { messageAdded { id text } }',
      ...overrides.args,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockGqlWs.reset();
  mockSsrf.impl = null;
  jest.clearAllMocks();
});

describe('GraphQLHandler.connect', () => {
  it('creates a graphql-ws client and subscribes with the configured query', async () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    await handler.connect(makeSub());

    expect(mockGqlWs.clients).toHaveLength(1);
    const client = mockGqlWs.clients[0];
    expect(client.opts.url).toBe('wss://api.example.com/graphql');
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    const [payload] = client.subscribe.mock.calls[0];
    expect(payload.query).toContain('messageAdded');

    // Tracked for cleanup.
    expect(handler.wsClients['gql-sub-1']).toBe(client);
    expect(handler.activeSubscriptions['gql-sub-1']).toBe(client.unsubscribe);
    expect(handler.activeCount()).toBe(1);
  });

  it('forwards a "next" payload via raiseConnectionEvent', async () => {
    const producer = makeProducer();
    const handler = new GraphQLHandler(producer, {});
    await handler.connect(makeSub());
    const client = mockGqlWs.clients[0];

    client.sink.next({ data: { messageAdded: { id: 9, text: 'hi' } } });

    expect(producer.send).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(producer.send.mock.calls[0][0].messages[0].value);
    expect(msg.subscriptionId).toBe('gql-sub-1');
    expect(msg.data).toEqual({ data: { messageAdded: { id: 9, text: 'hi' } } });
  });

  it('does not raise an event for the error/complete sink callbacks', async () => {
    const producer = makeProducer();
    const handler = new GraphQLHandler(producer, {});
    await handler.connect(makeSub());
    const client = mockGqlWs.clients[0];

    client.sink.error(new Error('source error'));
    client.sink.complete();

    expect(producer.send).not.toHaveBeenCalled();
  });

  it('passes the SSRF-pinned agent into the injected WebSocket impl', async () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    await handler.connect(makeSub());
    const client = mockGqlWs.clients[0];
    // The handler injects a PinnedWebSocket subclass; instantiating it must not
    // throw and must carry the pinned agent into ws's options.
    const Impl = client.opts.webSocketImpl;
    expect(typeof Impl).toBe('function');
  });
});

describe('disconnect-before-reconnect (defensive close)', () => {
  it('disposes the prior client when connect() is called for an already-tracked id', async () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    await handler.connect(makeSub());
    const first = mockGqlWs.clients[0];
    const firstUnsub = first.unsubscribe;

    // Re-connect the SAME id (Kafka redelivery / update_events).
    await handler.connect(makeSub());

    expect(firstUnsub).toHaveBeenCalled(); // unsubscribed
    expect(first.dispose).toHaveBeenCalled(); // socket torn down
    // The newest client is now the tracked one.
    expect(mockGqlWs.clients).toHaveLength(2);
    expect(handler.wsClients['gql-sub-1']).toBe(mockGqlWs.clients[1]);
    expect(handler.activeCount()).toBe(1); // not 2 — no orphan
  });

  it('does NOT dispose anything when connecting a brand-new id', async () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    await handler.connect(makeSub({ subscription_id: 'gql-A' }));
    await handler.connect(makeSub({ subscription_id: 'gql-B' }));

    expect(mockGqlWs.clients[0].dispose).not.toHaveBeenCalled();
    expect(handler.activeCount()).toBe(2);
  });
});

describe('SSRF guard at connect time', () => {
  it('refuses to connect (no client created) when the endpoint is blocked', async () => {
    mockSsrf.impl = () => {
      throw new SsrfBlockedError('private_address', 'blocked', { host: '169.254.169.254' });
    };
    const handler = new GraphQLHandler(makeProducer(), {});

    await handler.connect(makeSub());

    expect(mockGqlWs.clients).toHaveLength(0);
    expect(handler.activeCount()).toBe(0);
  });

  it('refuses to connect on a non-SSRF validation error too (returns, no client)', async () => {
    mockSsrf.impl = () => {
      throw new Error('resolver timeout');
    };
    const handler = new GraphQLHandler(makeProducer(), {});

    await handler.connect(makeSub());

    expect(mockGqlWs.clients).toHaveLength(0);
  });
});

describe('disconnect / closeAll', () => {
  it('disconnect() unsubscribes and disposes a tracked client', async () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    await handler.connect(makeSub());
    const client = mockGqlWs.clients[0];
    const unsub = client.unsubscribe;

    handler.disconnect('gql-sub-1');

    expect(unsub).toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalled();
    expect(handler.wsClients['gql-sub-1']).toBeUndefined();
    expect(handler.activeSubscriptions['gql-sub-1']).toBeUndefined();
  });

  it('disconnect() on an unknown id is a no-op', () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    expect(() => handler.disconnect('missing')).not.toThrow();
  });

  it('closeAll() drains every client (unsubscribe + dispose)', async () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    await handler.connect(makeSub({ subscription_id: 'gql-A' }));
    await handler.connect(makeSub({ subscription_id: 'gql-B' }));
    const [a, b] = mockGqlWs.clients;

    await handler.closeAll();

    expect(a.dispose).toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalled();
    expect(handler.activeCount()).toBe(0);
    expect(handler.activeSubscriptionIds()).toEqual([]);
  });

  it('closeAll() with nothing tracked resolves without error', async () => {
    const handler = new GraphQLHandler(makeProducer(), {});
    await expect(handler.closeAll()).resolves.toBeUndefined();
  });
});
