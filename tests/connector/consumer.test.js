/**
 * Unit tests for the connector consumer/index wiring (P1-6, connector half).
 *
 * src/subscription-connector/index.js is an IIFE that wires Redis/Kafka/PG and
 * keeps handleMessage / reconcileOwnedSubscriptions / partition-ownership as
 * MODULE-PRIVATE functions (none are exported). To exercise the REAL code
 * (rather than re-implement it) we mock every external client + the two
 * handlers, then require the module so its IIFE runs and registers its
 * callbacks against our mocks. We capture:
 *   - the `eachMessage` handler passed to consumer.run  → drives handleMessage
 *     + the manual commit-even-on-error contract,
 *   - the GROUP_JOIN handler passed to consumer.on      → drives
 *     reconcileOwnedSubscriptions + partition-ownership sharding.
 *
 * kafkajs is only PARTIALLY mocked: Partitioners (the real DefaultPartitioner
 * the connector uses for `partitionFor`), CompressionTypes and logLevel are
 * kept real so the ownership mapping is identical to the producer's.
 *
 * Covered contracts:
 *   - handleMessage topic dispatch (subscription_events / update_events /
 *     unsubscribe_events) and its graceful-return branches,
 *   - manual commit fires even when the handler path errors (cursor advances),
 *   - reconcile only touches `sub:*` keys — rate-limit counters are skipped,
 *   - P1-2 partition ownership: reconcile connects ONLY to subs whose partition
 *     this pod owns, and releases subs it no longer owns,
 *   - P1-10 Postgres fallback on a Redis miss (re-warms Redis; a true miss in
 *     BOTH stores is treated as deleted),
 *   - update_events disconnect-then-reconnect ordering.
 *
 * No network, no DB, deterministic.
 */

// ---------------------------------------------------------------------------
// Shared mock state. Everything hangs off `mock`-prefixed holders so the
// jest.mock factories may reference them (jest hoists factories above the
// module body and forbids closing over other locals).
// ---------------------------------------------------------------------------

// Redis: a tiny in-memory store + scriptable scan. `data` backs get/set/del;
// `scanResult` lets a test control exactly what SCAN returns.
const mockRedis = {
  data: new Map(),
  scanKeys: [], // keys SCAN should yield (single page)
  getImpl: null, // optional override to force a throw
  reset() {
    this.data = new Map();
    this.scanKeys = [];
    this.getImpl = null;
  },
};

// Postgres: scriptable query() so a test can simulate a row, a miss, a throw,
// or the SELECT 1 probe.
const mockPg = {
  queryImpl: null,
  reset() {
    this.queryImpl = null;
  },
};

// Captured handlers + the consumer/producer spies.
const mockKafka = {
  eachMessage: null,
  groupJoin: null,
  consumer: null,
  producer: null,
  reset() {
    this.eachMessage = null;
    this.groupJoin = null;
  },
};

// The two connection handlers — replaced with spies so we can assert connect/
// disconnect calls from handleMessage + reconcile.
const mockHandlers = {
  graphql: null,
  websocket: null,
};

function makeHandlerSpy() {
  return {
    _ids: new Set(),
    connect: jest.fn(async sub => {
      if (sub && sub.subscription_id) mockHandlers._lastConnected = sub;
    }),
    disconnect: jest.fn(),
    activeCount: jest.fn(() => 0),
    activeSubscriptionIds: jest.fn(function () {
      return Array.from(this._ids);
    }),
    closeAll: jest.fn(async () => {}),
  };
}

jest.mock('@redis/client', () => ({
  createClient: jest.fn(() => {
    const { EventEmitter: EE } = require('events');
    const client = new EE();
    client.connect = jest.fn(async () => {});
    client.quit = jest.fn(async () => {});
    client.get = jest.fn(async key => {
      if (mockRedis.getImpl) return mockRedis.getImpl(key);
      return mockRedis.data.has(key) ? mockRedis.data.get(key) : null;
    });
    client.set = jest.fn(async (key, val) => {
      mockRedis.data.set(key, val);
      return 'OK';
    });
    client.del = jest.fn(async key => {
      mockRedis.data.delete(key);
      return 1;
    });
    // Single-page scan: cursor 0 terminates the do/while in the connector.
    client.scan = jest.fn(async () => ({ cursor: 0, keys: mockRedis.scanKeys }));
    return client;
  }),
}));

jest.mock('kafkajs', () => {
  const actual = jest.requireActual('kafkajs');
  return {
    // Keep the REAL partitioner/compression/logLevel so partition ownership
    // matches the management producer exactly.
    ...actual,
    Kafka: jest.fn(() => ({
      producer: jest.fn(() => {
        mockKafka.producer = {
          connect: jest.fn(async () => {}),
          disconnect: jest.fn(async () => {}),
          send: jest.fn(async () => {}),
        };
        return mockKafka.producer;
      }),
      consumer: jest.fn(() => {
        const events = { GROUP_JOIN: 'consumer.group_join' };
        mockKafka.consumer = {
          events,
          connect: jest.fn(async () => {}),
          disconnect: jest.fn(async () => {}),
          subscribe: jest.fn(async () => {}),
          on: jest.fn((evt, cb) => {
            if (evt === events.GROUP_JOIN) mockKafka.groupJoin = cb;
          }),
          run: jest.fn(async ({ eachMessage }) => {
            mockKafka.eachMessage = eachMessage;
          }),
          commitOffsets: jest.fn(async () => {}),
        };
        return mockKafka.consumer;
      }),
    })),
  };
});

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: jest.fn(async (...args) => {
      if (mockPg.queryImpl) return mockPg.queryImpl(...args);
      // Default: the SELECT 1 startup probe succeeds.
      return { rowCount: 1, rows: [{ '?column?': 1 }] };
    }),
    end: jest.fn(async () => {}),
  })),
}));

jest.mock('../../src/lib/metrics-server', () => ({
  startMetricsServer: jest.fn(() => ({ close: cb => cb && cb() })),
}));

// Replace the handler classes with our spies (constructed once by the IIFE).
jest.mock('../../src/subscription-connector/handlers/graphqlHandler', () =>
  jest.fn(() => mockHandlers.graphql)
);
jest.mock('../../src/subscription-connector/handlers/webSocketHandler', () =>
  jest.fn(() => mockHandlers.websocket)
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { subscriptionCacheKey } = require('../../src/lib/subscription-cache');

// Drive a single Kafka message through the captured eachMessage handler.
function deliver(topic, subscriptionId, { partition = 0, offset = '0' } = {}) {
  return mockKafka.eachMessage({
    topic,
    partition,
    message: {
      value: subscriptionId == null ? null : Buffer.from(String(subscriptionId)),
      offset,
    },
  });
}

// Fire the GROUP_JOIN handler with a partition assignment, then let the async
// reconcile it kicks off settle. `assignment` is EITHER an array (back-compat:
// applies to subscription_events, the canonical OWNERSHIP_TOPIC) OR a per-topic
// map { subscription_events:[...], update_events:[...], unsubscribe_events:[...] }
// so a test can model kafkajs's RoundRobinAssigner handing DIFFERENT partitions
// of each co-subscribed topic to this pod (the divergent-assignment scenario).
async function joinWithPartitions(assignment) {
  const memberAssignment = Array.isArray(assignment)
    ? { subscription_events: assignment }
    : assignment;
  mockKafka.groupJoin({
    payload: { memberAssignment },
  });
  // reconcile is fire-and-forget inside GROUP_JOIN; flush microtasks + the
  // pLimit chain.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

function gqlSub(id, extra = {}) {
  return {
    subscription_id: id,
    connection_type: 'graphql',
    args: { endpoint_url: 'wss://api.example.com/graphql', query: 'subscription { x }' },
    ...extra,
  };
}

// Load index.js fresh with all the above mocks in force and wait for the IIFE
// to register its callbacks.
async function loadConnector() {
  jest.isolateModules(() => {
    require('../../src/subscription-connector/index.js');
  });
  // The IIFE is async (awaits redis/pg/kafka connect). Flush until eachMessage
  // + groupJoin are captured.
  for (let i = 0; i < 20 && !mockKafka.eachMessage; i++) {
    await new Promise(r => setImmediate(r));
  }
}

let exitSpy;

beforeEach(async () => {
  mockRedis.reset();
  mockPg.reset();
  mockKafka.reset();
  mockHandlers.graphql = makeHandlerSpy();
  mockHandlers.websocket = makeHandlerSpy();
  // The IIFE calls process.exit(1) only on a startup throw; stub it so a
  // surprise can't kill the jest worker, and assert it's NOT called on the
  // happy path.
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  jest.clearAllMocks();
  await loadConnector();
});

afterEach(() => {
  exitSpy.mockRestore();
  // Drop the SIGTERM/SIGINT/unhandledRejection/uncaughtException listeners the
  // IIFE registered so they don't accumulate across the suite.
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
});

describe('startup wiring', () => {
  it('registers an eachMessage handler and a GROUP_JOIN handler', () => {
    expect(typeof mockKafka.eachMessage).toBe('function');
    expect(typeof mockKafka.groupJoin).toBe('function');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('handleMessage — subscription_events', () => {
  it('connects the right handler when the sub is in Redis', async () => {
    mockRedis.data.set(subscriptionCacheKey('s1'), JSON.stringify(gqlSub('s1')));
    await deliver('subscription_events', 's1');
    expect(mockHandlers.graphql.connect).toHaveBeenCalledTimes(1);
    expect(mockHandlers.graphql.connect.mock.calls[0][0].subscription_id).toBe('s1');
  });

  it('does NOT connect when the sub is absent from BOTH Redis and Postgres', async () => {
    mockPg.queryImpl = async () => ({ rowCount: 0, rows: [] }); // true miss
    await deliver('subscription_events', 'ghost');
    expect(mockHandlers.graphql.connect).not.toHaveBeenCalled();
    expect(mockHandlers.websocket.connect).not.toHaveBeenCalled();
  });

  it('returns gracefully (no connect) on an empty message value', async () => {
    await deliver('subscription_events', null);
    expect(mockHandlers.graphql.connect).not.toHaveBeenCalled();
  });

  it('skips a subscription whose connection_type has no handler', async () => {
    mockRedis.data.set(
      subscriptionCacheKey('s-bad'),
      JSON.stringify({ subscription_id: 's-bad', connection_type: 'carrier-pigeon', args: {} })
    );
    await deliver('subscription_events', 's-bad');
    expect(mockHandlers.graphql.connect).not.toHaveBeenCalled();
    expect(mockHandlers.websocket.connect).not.toHaveBeenCalled();
  });
});

describe('P1-10 — Postgres fallback on Redis miss', () => {
  it('reads the row from Postgres, re-warms Redis, and connects when Redis misses', async () => {
    // Redis empty for s2; PG has the row (after the SELECT 1 probe already ran
    // at startup, so queryImpl now only sees the fallback SELECT).
    mockPg.queryImpl = async (sql, params) => {
      expect(params).toEqual(['s2']);
      return {
        rowCount: 1,
        rows: [
          {
            subscription_id: 's2',
            organization_id: 'org-1',
            connection_type: 'websocket',
            args: { endpoint_url: 'wss://x.example.com', message: {} },
            webhook_url: 'https://hook.example.com',
            webhook_secret: 'shh',
          },
        ],
      };
    };

    await deliver('subscription_events', 's2');

    // Connected via the websocket handler from the PG row...
    expect(mockHandlers.websocket.connect).toHaveBeenCalledTimes(1);
    // ...and Redis was re-warmed with the row.
    const warmed = mockRedis.data.get(subscriptionCacheKey('s2'));
    expect(warmed).toBeTruthy();
    expect(JSON.parse(warmed).subscription_id).toBe('s2');
  });

  it('treats a transient Postgres error as "leave it alone" (no connect, no crash)', async () => {
    mockPg.queryImpl = async () => {
      throw new Error('connection reset');
    };
    await deliver('subscription_events', 's3');
    expect(mockHandlers.graphql.connect).not.toHaveBeenCalled();
    expect(mockHandlers.websocket.connect).not.toHaveBeenCalled();
  });
});

describe('handleMessage — update_events', () => {
  it('disconnects then reconnects with the fresh config (in that order)', async () => {
    mockRedis.data.set(subscriptionCacheKey('s4'), JSON.stringify(gqlSub('s4')));
    const calls = [];
    mockHandlers.graphql.disconnect.mockImplementation(() => calls.push('disconnect'));
    mockHandlers.graphql.connect.mockImplementation(async () => calls.push('connect'));

    await deliver('update_events', 's4');

    expect(calls).toEqual(['disconnect', 'connect']);
    expect(mockHandlers.graphql.disconnect).toHaveBeenCalledWith('s4');
  });

  it('does nothing when the updated sub is gone from both stores', async () => {
    mockPg.queryImpl = async () => ({ rowCount: 0, rows: [] });
    await deliver('update_events', 'gone');
    expect(mockHandlers.graphql.disconnect).not.toHaveBeenCalled();
    expect(mockHandlers.graphql.connect).not.toHaveBeenCalled();
  });
});

describe('handleMessage — unsubscribe_events', () => {
  it('disconnects via the cached connection_type and deletes the Redis key', async () => {
    const key = subscriptionCacheKey('s5');
    mockRedis.data.set(key, JSON.stringify(gqlSub('s5')));

    await deliver('unsubscribe_events', 's5');

    expect(mockHandlers.graphql.disconnect).toHaveBeenCalledWith('s5');
    expect(mockRedis.data.has(key)).toBe(false); // cache cleaned up
  });

  it('falls back to disconnecting EVERY handler when the Redis entry is already gone', async () => {
    // No Redis entry → the connector closes both handlers to avoid leaking a
    // socket when the cache was wiped before the unsubscribe arrived.
    await deliver('unsubscribe_events', 's6');
    expect(mockHandlers.graphql.disconnect).toHaveBeenCalledWith('s6');
    expect(mockHandlers.websocket.disconnect).toHaveBeenCalledWith('s6');
  });
});

describe('manual commit even on handler error', () => {
  it('commits offset+1 after a successful handle', async () => {
    mockRedis.data.set(subscriptionCacheKey('s7'), JSON.stringify(gqlSub('s7')));
    await deliver('subscription_events', 's7', { partition: 2, offset: '41' });
    expect(mockKafka.consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'subscription_events', partition: 2, offset: '42' },
    ]);
  });

  it('STILL commits offset+1 when the handler path throws (cursor must advance)', async () => {
    // Force connect() to throw so the eachMessage try/catch is exercised; the
    // commit must still fire so the partition doesn't lock up on a poison msg.
    mockRedis.data.set(subscriptionCacheKey('s8'), JSON.stringify(gqlSub('s8')));
    mockHandlers.graphql.connect.mockImplementation(async () => {
      throw new Error('boom in connect');
    });

    await expect(
      deliver('subscription_events', 's8', { partition: 1, offset: '99' })
    ).resolves.toBeUndefined();

    expect(mockKafka.consumer.commitOffsets).toHaveBeenCalledWith([
      { topic: 'subscription_events', partition: 1, offset: '100' },
    ]);
  });
});

describe('P1-2 — reconcile only touches sub:* keys and owned partitions', () => {
  it('skips non-subscription keys (rate-limit counters) during reconcile', async () => {
    // Mix a real sub key with foreign keys that must NOT be parsed/connected.
    // 'a' maps to partition 4 under the real DefaultPartitioner (verified), so
    // owning partition 4 means we own 'a'.
    mockRedis.data.set(subscriptionCacheKey('a'), JSON.stringify(gqlSub('a')));
    mockRedis.scanKeys = [
      subscriptionCacheKey('a'),
      'ratelimit:org-1:1699999999',
      'auth-rl:1.2.3.4:1699999999',
    ];

    await joinWithPartitions([4]);

    // Only the real subscription got a connect; the rate-limit keys were
    // filtered out by the sub:* prefix check (never JSON.parsed/dialed).
    expect(mockHandlers.graphql.connect).toHaveBeenCalledTimes(1);
    expect(mockHandlers.graphql.connect.mock.calls[0][0].subscription_id).toBe('a');
  });

  it('connects ONLY to subscriptions whose partition this pod owns', async () => {
    // 'a' -> partition 4, 'sub-xyz' -> partition 1 (real partitioner). Own only
    // partition 1, so 'sub-xyz' connects and 'a' is skipped.
    mockRedis.data.set(subscriptionCacheKey('a'), JSON.stringify(gqlSub('a')));
    mockRedis.data.set(subscriptionCacheKey('sub-xyz'), JSON.stringify(gqlSub('sub-xyz')));
    mockRedis.scanKeys = [subscriptionCacheKey('a'), subscriptionCacheKey('sub-xyz')];

    await joinWithPartitions([1]);

    const connectedIds = mockHandlers.graphql.connect.mock.calls.map(c => c[0].subscription_id);
    expect(connectedIds).toEqual(['sub-xyz']);
  });

  it('releases a held subscription whose partition this pod no longer owns', async () => {
    // The websocket handler is currently holding 'a' (partition 4). On a
    // rebalance to partition 1 only, 'a' must be released (disconnected).
    mockHandlers.websocket._ids = new Set(['a']);
    mockRedis.scanKeys = [];

    await joinWithPartitions([1]);

    expect(mockHandlers.websocket.disconnect).toHaveBeenCalledWith('a');
  });

  it('keeps a held subscription whose partition is still owned', async () => {
    mockHandlers.websocket._ids = new Set(['a']); // partition 4
    mockRedis.scanKeys = [];

    await joinWithPartitions([4]);

    expect(mockHandlers.websocket.disconnect).not.toHaveBeenCalledWith('a');
  });
});

describe('P1-2 — cross-topic ownership guard under divergent (multi-replica) assignment', () => {
  // kafkajs's default RoundRobinAssigner flattens every (topic,partition) pair
  // across the three co-subscribed topics into ONE list and round-robins that
  // flat index, so it does NOT guarantee partition p of update_events lands on
  // the same pod as partition p of subscription_events. At >=3 replicas an
  // update_events/unsubscribe_events message can therefore reach a pod that
  // does NOT own the subscription_events (canonical OWNERSHIP_TOPIC) partition
  // for that id — i.e. a pod that never holds the upstream socket. The guard at
  // src/subscription-connector/index.js (initialReloadDone && !ownsSubscription)
  // must drop those off-pod messages: a stray connect() would open a DUPLICATE
  // upstream and a stray unsubscribe Redis-delete would LEAK the owning pod's
  // socket forever.
  //
  // Ownership is keyed solely off the subscription_events partition for the id
  // (partitionFor uses the real DefaultPartitioner, OWNERSHIP_TOPIC). Under the
  // real partitioner: 'sub-xyz' -> partition 1 (we OWN it), 's-notowned' ->
  // partition 0 (we do NOT own it). We hand this pod a 3-replica-style split:
  // subscription_events partition [1] only, but DIVERGENT update_events /
  // unsubscribe_events sets that ALSO include partition 0 — modelling kafkajs
  // delivering 's-notowned' lifecycle events here even though pod 0 owns it.

  // Drive GROUP_JOIN with the divergent assignment so initialReloadDone is true
  // and ownedPartitions = {1} (from subscription_events). The update_events /
  // unsubscribe_events partition lists differ on purpose; the guard reads only
  // ownedPartitions (subscription_events), so they don't affect ownership.
  async function joinDivergent() {
    mockRedis.scanKeys = [];
    await joinWithPartitions({
      subscription_events: [1],
      update_events: [0, 1],
      unsubscribe_events: [0, 1],
    });
  }

  it('IGNORES an update_events message for a sub whose subscription_events partition this pod does NOT own', async () => {
    // Seed Redis as if the config exists (so the ONLY reason to skip is the
    // ownership guard, not a cache miss). 's-notowned' -> partition 0 ∉ {1}.
    mockRedis.data.set(subscriptionCacheKey('s-notowned'), JSON.stringify(gqlSub('s-notowned')));
    await joinDivergent();
    jest.clearAllMocks(); // drop any connects from the initial reconcile

    await deliver('update_events', 's-notowned');

    // The owning pod (partition 0) handles the reload; this pod must do nothing.
    expect(mockHandlers.graphql.disconnect).not.toHaveBeenCalled();
    expect(mockHandlers.graphql.connect).not.toHaveBeenCalled();
  });

  it('IGNORES an unsubscribe_events message for a not-owned sub (no disconnect, Redis key preserved)', async () => {
    const key = subscriptionCacheKey('s-notowned'); // partition 0 ∉ {1}
    mockRedis.data.set(key, JSON.stringify(gqlSub('s-notowned')));
    await joinDivergent();
    jest.clearAllMocks();

    await deliver('unsubscribe_events', 's-notowned');

    // A stray delete here would leak the owning pod's socket — assert neither
    // a disconnect NOR the Redis cleanup fired off the owning pod.
    expect(mockHandlers.graphql.disconnect).not.toHaveBeenCalled();
    expect(mockHandlers.websocket.disconnect).not.toHaveBeenCalled();
    expect(mockRedis.data.has(key)).toBe(true);
  });

  it('positive control: ACTS on update/unsubscribe for a sub this pod DOES own under the same assignment', async () => {
    // 'sub-xyz' -> partition 1 ∈ {1}: owned, so both topics must be handled.
    mockRedis.data.set(subscriptionCacheKey('sub-xyz'), JSON.stringify(gqlSub('sub-xyz')));
    await joinDivergent();
    jest.clearAllMocks();

    await deliver('update_events', 'sub-xyz');
    expect(mockHandlers.graphql.disconnect).toHaveBeenCalledWith('sub-xyz');
    expect(mockHandlers.graphql.connect).toHaveBeenCalledTimes(1);
    expect(mockHandlers.graphql.connect.mock.calls[0][0].subscription_id).toBe('sub-xyz');

    jest.clearAllMocks();
    const key = subscriptionCacheKey('sub-xyz');
    await deliver('unsubscribe_events', 'sub-xyz');
    expect(mockHandlers.graphql.disconnect).toHaveBeenCalledWith('sub-xyz');
    expect(mockRedis.data.has(key)).toBe(false); // owned → cache cleaned up
  });
});
