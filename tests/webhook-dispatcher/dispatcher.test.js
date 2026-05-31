/**
 * Unit tests for the webhook-dispatcher delivery / retry / DLQ / idempotency
 * engine (P1-6 dispatcher half + P2-21 send-time SSRF).
 *
 * The dispatcher entrypoint (src/webhook-dispatcher/index.js) creates its
 * pg Pool / Redis client / kafkajs producer+consumer as MODULE SINGLETONS and
 * runs a bootstrap IIFE on require. The exported functions close over those
 * singletons, so to drive them as pure units we replace every external module
 * (pg, @redis/client, axios, kafkajs, ssrf-guard, notifications, email,
 * metrics-server, prom-client) with jest mocks BEFORE the require, and program
 * the mocks per-test. No live Postgres / Redis / Kafka is touched.
 *
 * Timers: fake timers are installed at module scope so the bootstrap IIFE's
 * setInterval calls (retry poller, notification poller) register against the
 * fake clock and never auto-fire (no real open handles, deterministic).
 */

// Fake timers BEFORE require so the bootstrap IIFE's setInterval is inert.
jest.useFakeTimers();

// ---- Mock the external clients. Each factory exposes jest.fn()s captured
// ---- below via require() so the tests can program them. ----

// Single shared query fn so module-level `pool` and the tests agree.
const mockQuery = jest.fn();
const mockPoolEnd = jest.fn().mockResolvedValue(undefined);
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: mockQuery,
    end: mockPoolEnd,
  })),
}));

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn().mockResolvedValue('OK');
jest.mock('@redis/client', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    async connect() {},
    async quit() {},
    get: mockRedisGet,
    set: mockRedisSet,
  })),
}));

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  post: (...args) => mockAxiosPost(...args),
}));

const mockProducerSend = jest.fn().mockResolvedValue([{ topicName: 'noop', errorCode: 0 }]);
jest.mock('kafkajs', () => {
  const actual = jest.requireActual('kafkajs');
  return {
    // Keep the real enums (CompressionTypes, logLevel) so resolveCompression
    // and config code behave exactly as in prod.
    logLevel: actual.logLevel,
    CompressionTypes: actual.CompressionTypes,
    Kafka: jest.fn(() => ({
      producer: jest.fn(() => ({
        async connect() {},
        async disconnect() {},
        send: mockProducerSend,
      })),
      consumer: jest.fn(() => ({
        async connect() {},
        async disconnect() {},
        async subscribe() {},
        async run() {},
      })),
    })),
  };
});

// SSRF guard: by default produce a benign axios config (delivery proceeds).
// Tests that exercise the block path override guardedAxiosConfig per-test.
const mockGuardedAxiosConfig = jest.fn(async (_url, base = {}) => ({ ...base, maxRedirects: 0 }));
const { SsrfBlockedError: RealSsrfBlockedError } = jest.requireActual('../../src/lib/ssrf-guard');
jest.mock('../../src/lib/ssrf-guard', () => {
  const real = jest.requireActual('../../src/lib/ssrf-guard');
  return {
    SsrfBlockedError: real.SsrfBlockedError,
    guardedAxiosConfig: (...args) => mockGuardedAxiosConfig(...args),
  };
});

// Notifications: capture dispatchNotification; pollNotificationAttempts is a
// no-op so the bootstrap's notification poller does nothing.
const mockDispatchNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/lib/notifications', () => ({
  dispatchNotification: (...args) => mockDispatchNotification(...args),
  pollNotificationAttempts: jest.fn().mockResolvedValue(undefined),
}));

// Email transport — inert.
jest.mock('../../src/lib/email', () => ({
  makeEmailTransport: () => ({ enabled: false, from: 'noreply@test', async send() {} }),
}));

// Metrics server — don't bind a real port / start defaultMetrics collection.
jest.mock('../../src/lib/metrics-server', () => ({
  startMetricsServer: () => ({ close: cb => cb && cb() }),
}));

// prom-client — inert counters/gauges/histograms so requiring the dispatcher
// (and, separately, the real outbox-drainer test) never collides on the global
// registry, and metric .inc()/.observe() calls in the code under test no-op.
jest.mock('prom-client', () => {
  const noop = () => {};
  const meter = { inc: noop, observe: noop, set: noop, reset: noop };
  return {
    Counter: jest.fn(() => meter),
    Histogram: jest.fn(() => meter),
    Gauge: jest.fn(() => meter),
    register: { metrics: async () => '', contentType: 'text/plain' },
    collectDefaultMetrics: noop,
  };
});

// Outbox drainer — keep the real module (so its functions can be tested in
// outbox-drainer.test.js), but the bootstrap only calls startOutboxDrainer when
// pgReady; we make the SELECT 1 boot probe resolve and the drainer harmless by
// letting it register against fake timers (never fires).

// Now require the module under test. The bootstrap IIFE runs here against the
// mocks above; we give it a resolved SELECT 1 so it exercises the happy boot
// path, then reset mocks in beforeEach for the per-test assertions.
mockQuery.mockResolvedValue({ rows: [{ n: 0 }], rowCount: 1 });

const dispatcher = require('../../src/webhook-dispatcher/index.js');
const { subscriptionCacheKey } = require('../../src/lib/subscription-cache');

// Real timers for the test bodies (the async function-under-test awaits
// resolved promises; we don't depend on the fake clock inside tests).
jest.useRealTimers();

const SUB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORG_ID = '11111111-2222-3333-4444-555555555555';
const EVENT_ID = '99999999-8888-7777-6666-555555555555';
const WEBHOOK_URL = 'https://hooks.example.com/in';
const SECRET = 'whsec_test_secret';

/** Build the JSON string the dispatcher caches in Redis for a subscription. */
function cachedSubscription(overrides = {}) {
  return JSON.stringify({
    subscription_id: SUB_ID,
    organization_id: ORG_ID,
    webhook_url: WEBHOOK_URL,
    webhook_secret: SECRET,
    ...overrides,
  });
}

/** An axios-style error for a 5xx response. */
function httpError(status, data = 'err') {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data };
  return err;
}

/** An axios-style network error (no .response). */
function networkError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockRedisGet.mockReset();
  mockRedisSet.mockReset().mockResolvedValue('OK');
  mockAxiosPost.mockReset();
  mockProducerSend.mockReset().mockResolvedValue([{ topicName: 'noop', errorCode: 0 }]);
  mockDispatchNotification.mockReset().mockResolvedValue(undefined);
  mockGuardedAxiosConfig
    .mockReset()
    .mockImplementation(async (_url, base = {}) => ({ ...base, maxRedirects: 0 }));
  // Default: every DB write succeeds, gauges read 0.
  mockQuery.mockResolvedValue({ rows: [{ n: 0 }], rowCount: 1 });
});

/** Grab the args of a query whose SQL matches `re` (first match). */
function queryMatching(re) {
  const call = mockQuery.mock.calls.find(c => re.test(c[0]));
  return call ? { sql: call[0], params: call[1] } : null;
}

describe('claimEvent (atomic idempotency gate / ON CONFLICT path)', () => {
  it('returns true and inserts when no producer event id (nothing to dedup)', async () => {
    const ok = await dispatcher.claimEvent(SUB_ID, EVENT_ID, false, ORG_ID);
    expect(ok).toBe(true);
    // No producer id → no INSERT attempted at all.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns true when the INSERT claims the row (rowCount 1)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] });
    const ok = await dispatcher.claimEvent(SUB_ID, EVENT_ID, true, ORG_ID);
    expect(ok).toBe(true);
    const q = queryMatching(/INSERT INTO processed_events/);
    expect(q).not.toBeNull();
    expect(q.sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(q.params).toEqual([SUB_ID, EVENT_ID, ORG_ID]);
  });

  it('returns false (skip) when ON CONFLICT DO NOTHING claims nothing (rowCount 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const ok = await dispatcher.claimEvent(SUB_ID, EVENT_ID, true, ORG_ID);
    expect(ok).toBe(false);
  });

  it('fails OPEN (returns true) when the DB errors', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pg down'));
    const ok = await dispatcher.claimEvent(SUB_ID, EVENT_ID, true, ORG_ID);
    expect(ok).toBe(true);
  });
});

describe('sendWebhook — success path', () => {
  it('POSTs and records status=success with the HTTP status code', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: { ok: true } });

    await dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { hi: 1 }, EVENT_ID, 0);

    // Went through the SSRF guard and POSTed the pre-serialized body.
    expect(mockGuardedAxiosConfig).toHaveBeenCalledWith(
      WEBHOOK_URL,
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, cfg] = mockAxiosPost.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    expect(body).toBe(JSON.stringify({ data: { hi: 1 } }));
    expect(cfg.maxRedirects).toBe(0); // SSRF guard forces no-redirect

    const rec = queryMatching(/INSERT INTO delivery_events/);
    expect(rec).not.toBeNull();
    // params: [..., status(idx3), http_status_code(idx4), ...]
    expect(rec.params[3]).toBe('success');
    expect(rec.params[4]).toBe(200);
  });

  it('sends signed headers when a secret is present', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 202, data: '' });
    await dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { a: 1 }, EVENT_ID, 0);
    const cfgPassedToGuard = mockGuardedAxiosConfig.mock.calls[0][1];
    const headers = cfgPassedToGuard.headers;
    expect(headers['X-AnyHook-Signature']).toBeDefined();
    expect(headers['X-AnyHook-Timestamp']).toBeDefined();
    expect(headers['X-AnyHook-Event-Id']).toBe(EVENT_ID);
    expect(headers['X-AnyHook-Delivery-Attempt']).toBe('1');
  });

  it('sends UNSIGNED (no signature header) when the secret is missing', async () => {
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: '' });
    await dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, null, { a: 1 }, EVENT_ID, 0);
    const headers = mockGuardedAxiosConfig.mock.calls[0][1].headers;
    expect(headers['X-AnyHook-Signature']).toBeUndefined();
  });
});

describe('sendWebhook — failure / status semantics', () => {
  it('records status=retrying and throws when retryCount < maxRetries (500)', async () => {
    mockAxiosPost.mockRejectedValueOnce(httpError(500, 'boom'));

    await expect(
      dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { a: 1 }, EVENT_ID, 0)
    ).rejects.toThrow(/Webhook request failed/);

    const rec = queryMatching(/INSERT INTO delivery_events/);
    expect(rec.params[3]).toBe('retrying');
    expect(rec.params[4]).toBe(500); // http_status_code captured
  });

  it('records status=retrying on a timeout (no response)', async () => {
    mockAxiosPost.mockRejectedValueOnce(networkError('ECONNABORTED', 'timeout of 8000ms exceeded'));
    await expect(
      dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { a: 1 }, EVENT_ID, 2)
    ).rejects.toThrow();
    const rec = queryMatching(/INSERT INTO delivery_events/);
    expect(rec.params[3]).toBe('retrying');
    expect(rec.params[4]).toBeNull(); // no http_status_code on a network error
  });

  it('records status=retrying on connection-refused (ECONNREFUSED)', async () => {
    mockAxiosPost.mockRejectedValueOnce(networkError('ECONNREFUSED', 'connect ECONNREFUSED'));
    await expect(
      dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { a: 1 }, EVENT_ID, 0)
    ).rejects.toThrow();
    expect(queryMatching(/INSERT INTO delivery_events/).params[3]).toBe('retrying');
  });

  it('records status=dlq (not retrying) when retryCount === maxRetries', async () => {
    // maxRetries = retryIntervals.length = 6. retryCount 6 → terminal.
    mockAxiosPost.mockRejectedValueOnce(httpError(503));
    await expect(
      dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { a: 1 }, EVENT_ID, 6)
    ).rejects.toThrow();
    expect(queryMatching(/INSERT INTO delivery_events/).params[3]).toBe('dlq');
  });
});

describe('sendWebhook — send-time SSRF block (P2-21 / P0-4)', () => {
  it('does NOT POST, records status=dlq, and throws an .ssrfBlocked error when the target resolves private', async () => {
    // Force the guard to reject as if webhook_url resolved to 169.254.169.254.
    mockGuardedAxiosConfig.mockRejectedValueOnce(
      new RealSsrfBlockedError('private_address', 'Host resolves to a private/blocked address', {
        host: 'evil.example.com',
        address: '169.254.169.254',
      })
    );

    let thrown;
    try {
      await dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { a: 1 }, EVENT_ID, 0);
    } catch (e) {
      thrown = e;
    }

    // Tagged non-retryable so the caller routes straight to the DLQ.
    expect(thrown).toBeDefined();
    expect(thrown.ssrfBlocked).toBe(true);
    // The payload was NEVER POSTed to the blocked address.
    expect(mockAxiosPost).not.toHaveBeenCalled();
    // Recorded terminally as dlq (with the SSRF reason), not 'success'/'retrying'.
    const rec = queryMatching(/INSERT INTO delivery_events/);
    expect(rec).not.toBeNull();
    expect(rec.params[3]).toBe('dlq');
    const errMsg = rec.params[rec.params.length - 1];
    expect(String(errMsg)).toMatch(/SSRF guard blocked target/);
  });

  it('re-throws a non-SSRF guard error untouched (no DLQ record)', async () => {
    mockGuardedAxiosConfig.mockRejectedValueOnce(new Error('some other failure'));
    await expect(
      dispatcher.sendWebhook(SUB_ID, ORG_ID, WEBHOOK_URL, SECRET, { a: 1 }, EVENT_ID, 0)
    ).rejects.toThrow(/some other failure/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(queryMatching(/INSERT INTO delivery_events/)).toBeNull();
  });
});

describe('handleConnectionEvent', () => {
  function kafkaMessage(obj) {
    return { message: { value: Buffer.from(JSON.stringify(obj)) } };
  }

  it('skips an empty message without throwing or querying', async () => {
    await dispatcher.handleConnectionEvent({ message: { value: null } });
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('skips an unparseable (truncated) message body', async () => {
    await dispatcher.handleConnectionEvent({ message: { value: Buffer.from('{not json') } });
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('skips when subscriptionId is missing', async () => {
    await dispatcher.handleConnectionEvent(kafkaMessage({ eventId: EVENT_ID, data: {} }));
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it('returns early when the subscription is not in the Redis cache', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    await dispatcher.handleConnectionEvent(
      kafkaMessage({ subscriptionId: SUB_ID, eventId: EVENT_ID, data: { a: 1 } })
    );
    expect(mockRedisGet).toHaveBeenCalledWith(subscriptionCacheKey(SUB_ID));
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('delivers on success: claims the event then POSTs', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    // claimEvent INSERT wins, then the delivery_events insert.
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] }) // claim
      .mockResolvedValue({ rowCount: 1, rows: [] }); // recordDelivery
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: 'ok' });

    await dispatcher.handleConnectionEvent(
      kafkaMessage({ subscriptionId: SUB_ID, eventId: EVENT_ID, data: { a: 1 } })
    );

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    // No retry enqueued on success.
    expect(queryMatching(/INSERT INTO pending_retries/)).toBeNull();
  });

  it('idempotency skip: does NOT POST when claimEvent loses (ON CONFLICT rowCount 0)', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // claim lost

    await dispatcher.handleConnectionEvent(
      kafkaMessage({ subscriptionId: SUB_ID, eventId: EVENT_ID, data: { a: 1 } })
    );

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(queryMatching(/INSERT INTO pending_retries/)).toBeNull();
  });

  it('first-failure enqueues a retry (does not throw out)', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] }) // claim wins
      .mockResolvedValue({ rowCount: 1, rows: [] }); // recordDelivery + enqueue
    mockAxiosPost.mockRejectedValueOnce(httpError(500));

    await dispatcher.handleConnectionEvent(
      kafkaMessage({ subscriptionId: SUB_ID, eventId: EVENT_ID, data: { a: 1 } })
    );

    const enq = queryMatching(/INSERT INTO pending_retries/);
    expect(enq).not.toBeNull();
    // retry_count param (idx 4) is 0 — the attempt that just failed.
    expect(enq.params[4]).toBe(0);
  });

  it('SSRF block mid-deliver routes to the DLQ producer instead of enqueuing a retry', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] }) // claim wins
      .mockResolvedValue({ rowCount: 1, rows: [] }); // recordDelivery
    mockGuardedAxiosConfig.mockRejectedValueOnce(
      new RealSsrfBlockedError('private_address', 'blocked', { address: '10.0.0.1' })
    );

    await dispatcher.handleConnectionEvent(
      kafkaMessage({ subscriptionId: SUB_ID, eventId: EVENT_ID, data: { a: 1 } })
    );

    // Parked in the DLQ topic, NOT re-enqueued for retry.
    expect(mockProducerSend).toHaveBeenCalledWith(expect.objectContaining({ topic: 'dlq_events' }));
    expect(queryMatching(/INSERT INTO pending_retries/)).toBeNull();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});

describe('enqueueRetry — backoff ladder + GREATEST clobber-guard', () => {
  const ladder = [15, 60, 120, 360, 720, 1440]; // minutes

  it.each(ladder.map((mins, i) => [i, mins]))(
    'schedules next_attempt_at ≈ now + %s-index (%s min) for retryCount=%s',
    async retryCount => {
      const mins = ladder[retryCount];
      const before = Date.now();
      await dispatcher.enqueueRetry(
        EVENT_ID,
        SUB_ID,
        ORG_ID,
        JSON.stringify({ data: {} }),
        retryCount
      );
      const after = Date.now();

      const enq = queryMatching(/INSERT INTO pending_retries/);
      expect(enq).not.toBeNull();
      const nextAttemptAt = enq.params[5];
      expect(nextAttemptAt).toBeInstanceOf(Date);
      const delayMs = mins * 60 * 1000;
      // Allow for the small wall-clock delta around the call.
      expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + delayMs - 50);
      expect(nextAttemptAt.getTime()).toBeLessThanOrEqual(after + delayMs + 50);
      // retry_count param echoes the attempt that just failed.
      expect(enq.params[4]).toBe(retryCount);
    }
  );

  it('uses GREATEST(retry_count) + GREATEST(next_attempt_at) on conflict (clobber-guard)', async () => {
    await dispatcher.enqueueRetry(EVENT_ID, SUB_ID, ORG_ID, JSON.stringify({ data: {} }), 1);
    const enq = queryMatching(/INSERT INTO pending_retries/);
    expect(enq.sql).toMatch(
      /retry_count\s*=\s*GREATEST\(pending_retries\.retry_count,\s*EXCLUDED\.retry_count\)/
    );
    expect(enq.sql).toMatch(
      /next_attempt_at\s*=\s*GREATEST\(pending_retries\.next_attempt_at,\s*EXCLUDED\.next_attempt_at\)/
    );
    expect(enq.sql).toMatch(/locked_at\s*=\s*NULL/);
  });

  it('is a no-op (no INSERT) once retryCount >= maxRetries', async () => {
    await dispatcher.enqueueRetry(EVENT_ID, SUB_ID, ORG_ID, JSON.stringify({ data: {} }), 6);
    expect(queryMatching(/INSERT INTO pending_retries/)).toBeNull();
  });

  it('swallows a DB error (best-effort, no throw)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('insert failed'));
    await expect(
      dispatcher.enqueueRetry(EVENT_ID, SUB_ID, ORG_ID, JSON.stringify({ data: {} }), 0)
    ).resolves.toBeUndefined();
  });
});

describe('processClaimedRetry — Redis hit / fallback / terminal branches', () => {
  const baseRow = {
    event_id: EVENT_ID,
    subscription_id: SUB_ID,
    organization_id: ORG_ID,
    request_body: JSON.stringify({ data: { x: 1 } }),
    retry_count: 0,
  };

  it('Redis hit + success: fires the webhook then DELETEs the queue row', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: 'ok' });
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await dispatcher.processClaimedRetry({ ...baseRow });

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    // nextAttempt = retry_count + 1 = 1 → X-AnyHook-Delivery-Attempt header '2'
    const headers = mockGuardedAxiosConfig.mock.calls[0][1].headers;
    expect(headers['X-AnyHook-Delivery-Attempt']).toBe('2');
    expect(queryMatching(/DELETE FROM pending_retries/)).not.toBeNull();
  });

  it('Redis MISS → Postgres fallback → re-warm Redis, then deliver', async () => {
    mockRedisGet.mockResolvedValueOnce(null); // cache miss
    // PG fallback lookup returns the row.
    mockQuery.mockImplementation(async sql => {
      if (/FROM subscriptions WHERE subscription_id/.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              subscription_id: SUB_ID,
              organization_id: ORG_ID,
              webhook_url: WEBHOOK_URL,
              webhook_secret: SECRET,
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    mockAxiosPost.mockResolvedValueOnce({ status: 200, data: 'ok' });

    await dispatcher.processClaimedRetry({ ...baseRow });

    // Re-warmed the cache from the PG row.
    expect(mockRedisSet).toHaveBeenCalledWith(subscriptionCacheKey(SUB_ID), expect.any(String));
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(queryMatching(/DELETE FROM pending_retries/)).not.toBeNull();
  });

  it('subscription deleted (Redis miss + PG miss): DELETE row + record FAILED + notify', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockQuery.mockImplementation(async sql => {
      if (/FROM subscriptions WHERE subscription_id/.test(sql)) {
        return { rowCount: 0, rows: [] }; // not in PG either
      }
      return { rowCount: 1, rows: [] };
    });

    await dispatcher.processClaimedRetry({ ...baseRow, retry_count: 3 });

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(queryMatching(/DELETE FROM pending_retries/)).not.toBeNull();
    const rec = queryMatching(/INSERT INTO delivery_events/);
    expect(rec).not.toBeNull();
    expect(rec.params[3]).toBe('failed'); // distinct from dlq
    // 'failed' notification fan-out fired with the deleted-subscription marker.
    expect(mockDispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'failed', organizationId: ORG_ID })
    );
  });

  it('truncated/garbage request_body → cannot parse → DLQ + DELETE (no POST)', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await dispatcher.processClaimedRetry({
      ...baseRow,
      request_body: '{"data": {"big": "tru', // truncated JSON
    });

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockProducerSend).toHaveBeenCalledWith(expect.objectContaining({ topic: 'dlq_events' }));
    expect(queryMatching(/DELETE FROM pending_retries/)).not.toBeNull();
  });

  it('bad Redis payload (unparseable JSON): unlocks the row and bails (no POST, no DLQ)', async () => {
    mockRedisGet.mockResolvedValueOnce('{not-json');
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await dispatcher.processClaimedRetry({ ...baseRow });

    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockProducerSend).not.toHaveBeenCalled();
    // Unlocks the row so a later poll can retry once Redis recovers.
    const unlock = queryMatching(/UPDATE pending_retries SET locked_at = NULL/);
    expect(unlock).not.toBeNull();
    expect(unlock.params).toEqual([EVENT_ID]);
  });

  it('retrying → DLQ when nextAttempt reaches maxRetries', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    // retry_count 5 → nextAttempt 6 === maxRetries → terminal.
    mockAxiosPost.mockRejectedValueOnce(httpError(500));
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await dispatcher.processClaimedRetry({ ...baseRow, retry_count: 5 });

    // Goes to DLQ + deletes the queue row; does NOT re-enqueue.
    expect(mockProducerSend).toHaveBeenCalledWith(expect.objectContaining({ topic: 'dlq_events' }));
    expect(queryMatching(/DELETE FROM pending_retries/)).not.toBeNull();
    expect(queryMatching(/INSERT INTO pending_retries/)).toBeNull();
  });

  it('mid-retry failure (more attempts left) re-enqueues with the next backoff', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    mockAxiosPost.mockRejectedValueOnce(httpError(500));
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await dispatcher.processClaimedRetry({ ...baseRow, retry_count: 1 });

    // nextAttempt = 2 < maxRetries → re-enqueue, no DLQ, no delete.
    const enq = queryMatching(/INSERT INTO pending_retries/);
    expect(enq).not.toBeNull();
    expect(enq.params[4]).toBe(2); // scheduled the attempt that just failed (2)
    expect(mockProducerSend).not.toHaveBeenCalled();
  });

  it('SSRF block during a retry routes straight to DLQ (no further retries)', async () => {
    mockRedisGet.mockResolvedValueOnce(cachedSubscription());
    mockGuardedAxiosConfig.mockRejectedValueOnce(
      new RealSsrfBlockedError('private_address', 'blocked', { address: '169.254.169.254' })
    );
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await dispatcher.processClaimedRetry({ ...baseRow, retry_count: 1 });

    expect(mockProducerSend).toHaveBeenCalledWith(expect.objectContaining({ topic: 'dlq_events' }));
    expect(queryMatching(/DELETE FROM pending_retries/)).not.toBeNull();
    expect(queryMatching(/INSERT INTO pending_retries/)).toBeNull();
  });
});

describe('claimDueRetries', () => {
  it('sweeps stale locks and claims a batch via FOR UPDATE SKIP LOCKED', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // stale-lock sweep (fire-and-forget)
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ event_id: 'e1' }, { event_id: 'e2' }] });

    const rows = await dispatcher.claimDueRetries();
    expect(rows).toHaveLength(2);

    const claim = queryMatching(/FOR UPDATE SKIP LOCKED/);
    expect(claim).not.toBeNull();
    expect(claim.sql).toMatch(/UPDATE pending_retries/);
  });
});

describe('sendToDLQ', () => {
  it('publishes the parked payload to dlq_events and dispatches a dlq notification', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    await dispatcher.sendToDLQ(SUB_ID, ORG_ID, WEBHOOK_URL, { a: 1 }, EVENT_ID);

    expect(mockProducerSend).toHaveBeenCalledTimes(1);
    const arg = mockProducerSend.mock.calls[0][0];
    expect(arg.topic).toBe('dlq_events');
    const value = JSON.parse(arg.messages[0].value);
    expect(value).toMatchObject({
      subscriptionId: SUB_ID,
      organizationId: ORG_ID,
      eventId: EVENT_ID,
    });

    expect(mockDispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'dlq', organizationId: ORG_ID })
    );
  });

  it('does not throw if the producer send fails (best-effort)', async () => {
    mockProducerSend.mockRejectedValueOnce(new Error('kafka down'));
    await expect(
      dispatcher.sendToDLQ(SUB_ID, ORG_ID, WEBHOOK_URL, { a: 1 }, EVENT_ID)
    ).resolves.toBeUndefined();
  });
});

describe('recordDelivery — best-effort logging', () => {
  it('truncates oversized bodies before insert', async () => {
    const huge = 'x'.repeat(20000);
    await dispatcher.recordDelivery({
      subscriptionId: SUB_ID,
      organizationId: ORG_ID,
      eventId: EVENT_ID,
      status: 'success',
      requestBody: huge,
    });
    const rec = queryMatching(/INSERT INTO delivery_events/);
    const requestBodyParam = rec.params[7]; // request_body position
    expect(requestBodyParam.length).toBeLessThan(huge.length);
    expect(requestBodyParam.endsWith('...[truncated]')).toBe(true);
  });

  it('never throws when the DB insert fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('pg down'));
    await expect(
      dispatcher.recordDelivery({
        subscriptionId: SUB_ID,
        organizationId: ORG_ID,
        eventId: EVENT_ID,
        status: 'success',
      })
    ).resolves.toBeUndefined();
  });
});

describe('redriveDlqEvent', () => {
  it('re-enqueues a parked event with retry_count reset to 0, due immediately', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    const ok = await dispatcher.redriveDlqEvent({
      subscriptionId: SUB_ID,
      organizationId: ORG_ID,
      eventId: EVENT_ID,
      data: { a: 1 },
    });
    expect(ok).toBe(true);
    const enq = queryMatching(/INSERT INTO pending_retries/);
    expect(enq).not.toBeNull();
    expect(enq.sql).toMatch(/retry_count = 0/);
  });

  it('returns false when the message is missing subscriptionId/eventId', async () => {
    const ok = await dispatcher.redriveDlqEvent({ subscriptionId: SUB_ID });
    expect(ok).toBe(false);
    expect(queryMatching(/INSERT INTO pending_retries/)).toBeNull();
  });
});

describe('pLimit (bounded concurrency pool)', () => {
  it('never runs more than `concurrency` tasks at once', async () => {
    const limit = dispatcher.pLimit(2);
    let active = 0;
    let maxActive = 0;
    const task = () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it('resolves with the task result and propagates rejections', async () => {
    const limit = dispatcher.pLimit(1);
    await expect(limit(async () => 42)).resolves.toBe(42);
    await expect(limit(async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
  });
});

describe('resolveCompression', () => {
  const { CompressionTypes } = jest.requireActual('kafkajs');
  it('maps known codecs and defaults unknown/unset to None', () => {
    expect(dispatcher.resolveCompression('gzip')).toBe(CompressionTypes.GZIP);
    expect(dispatcher.resolveCompression('SNAPPY')).toBe(CompressionTypes.Snappy);
    expect(dispatcher.resolveCompression('lz4')).toBe(CompressionTypes.LZ4);
    expect(dispatcher.resolveCompression('zstd')).toBe(CompressionTypes.ZSTD);
    expect(dispatcher.resolveCompression('none')).toBe(CompressionTypes.None);
    expect(dispatcher.resolveCompression('')).toBe(CompressionTypes.None);
    expect(dispatcher.resolveCompression('bogus')).toBe(CompressionTypes.None);
  });
});

describe('handleConnectionBatch — safe-prefix offset commit', () => {
  function makeBatch(offsets) {
    return {
      messages: offsets.map(o => ({
        offset: String(o),
        value: Buffer.from(JSON.stringify({ subscriptionId: SUB_ID, eventId: `e${o}`, data: {} })),
      })),
    };
  }

  it('commits the contiguous prefix and stops at the first unhandled offset (gap)', async () => {
    // Subscription not cached → handleConnectionEvent returns early (handled),
    // so all messages are "handled" and the whole prefix commits.
    mockRedisGet.mockResolvedValue(null);

    const resolved = [];
    const resolveOffset = jest.fn(o => resolved.push(o));
    const heartbeat = jest.fn().mockResolvedValue(undefined);
    const commitOffsetsIfNecessary = jest.fn().mockResolvedValue(undefined);

    await dispatcher.handleConnectionBatch({
      batch: makeBatch([0, 1, 2]),
      resolveOffset,
      heartbeat,
      isRunning: () => true,
      isStale: () => false,
      commitOffsetsIfNecessary,
    });

    expect(resolved).toEqual(['0', '1', '2']);
    expect(commitOffsetsIfNecessary).toHaveBeenCalledTimes(1);
  });

  it('processes nothing when the consumer is no longer running (rebalance)', async () => {
    mockRedisGet.mockResolvedValue(cachedSubscription());
    const resolveOffset = jest.fn();
    await dispatcher.handleConnectionBatch({
      batch: makeBatch([0, 1]),
      resolveOffset,
      heartbeat: jest.fn().mockResolvedValue(undefined),
      isRunning: () => false, // not ours anymore
      isStale: () => false,
      commitOffsetsIfNecessary: jest.fn().mockResolvedValue(undefined),
    });
    // Nothing handled → nothing resolved.
    expect(resolveOffset).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });
});
