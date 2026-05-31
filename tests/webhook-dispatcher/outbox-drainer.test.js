/**
 * Unit tests for the outbox drainer (src/webhook-dispatcher/outbox-drainer.js).
 *
 * This module is already dependency-injected — every function takes its pg
 * pool / kafkajs producer / logger / gauges as arguments — so the tests just
 * pass jest mocks and assert the claim → deliver → mark / failure paths. No
 * live Postgres or Kafka is touched.
 */

const {
  claimDueOutbox,
  deliverOutboxRow,
  pollOutboxOnce,
  startOutboxDrainer,
} = require('../../src/webhook-dispatcher/outbox-drainer');

/** Silent logger so test output stays clean. */
function fakeLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** prom-client-style gauge stub recording set/reset calls. */
function fakeGauge() {
  return { set: jest.fn(), reset: jest.fn() };
}

function outboxRow(overrides = {}) {
  return {
    id: 1,
    topic: 'connection_events',
    message_key: 'sub-1',
    message_value: JSON.stringify({ subscriptionId: 'sub-1', data: { x: 1 } }),
    attempts: 0,
    ...overrides,
  };
}

describe('claimDueOutbox', () => {
  it('claims undelivered rows via FOR UPDATE SKIP LOCKED, stamping locked_by', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [outboxRow(), outboxRow({ id: 2 })] }),
    };
    const rows = await claimDueOutbox({ pool, batchSize: 50, workerId: 'worker-A' });

    expect(rows).toHaveLength(2);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/UPDATE outbox_events/);
    expect(sql).toMatch(/locked_at = NOW\(\), locked_by = \$2/);
    expect(params).toEqual([50, 'worker-A']);
  });
});

describe('deliverOutboxRow — success path', () => {
  it('publishes to the row.topic then marks the row delivered + unlocked', async () => {
    const producer = { send: jest.fn().mockResolvedValue([{ errorCode: 0 }]) };
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    const log = fakeLog();
    const row = outboxRow();

    await deliverOutboxRow({ pool, producer, log, compression: undefined, row });

    expect(producer.send).toHaveBeenCalledTimes(1);
    const sendArg = producer.send.mock.calls[0][0];
    expect(sendArg.topic).toBe('connection_events');
    expect(sendArg.messages[0]).toEqual({ key: row.message_key, value: row.message_value });
    // No compression key when compression is undefined.
    expect('compression' in sendArg).toBe(false);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SET delivered_at = NOW\(\), locked_at = NULL, locked_by = NULL/);
    expect(params).toEqual([row.id]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('passes the compression codec through when provided', async () => {
    const producer = { send: jest.fn().mockResolvedValue([]) };
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const { CompressionTypes } = require('kafkajs');

    await deliverOutboxRow({
      pool,
      producer,
      log: fakeLog(),
      compression: CompressionTypes.GZIP,
      row: outboxRow(),
    });

    expect(producer.send.mock.calls[0][0].compression).toBe(CompressionTypes.GZIP);
  });
});

describe('deliverOutboxRow — failure path', () => {
  it('on publish failure: does NOT mark delivered, unlocks + bumps attempts + records last_error', async () => {
    const producer = { send: jest.fn().mockRejectedValue(new Error('broker unreachable')) };
    const pool = { query: jest.fn().mockResolvedValue({}) };
    const log = fakeLog();
    const row = outboxRow({ id: 7 });

    await deliverOutboxRow({ pool, producer, log, compression: undefined, row });

    expect(log.error).toHaveBeenCalled();
    // The single UPDATE is the failure-bookkeeping one (no delivered_at = NOW()).
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/attempts = attempts \+ 1/);
    expect(sql).toMatch(/last_error = \$1/);
    expect(sql).not.toMatch(/delivered_at = NOW\(\)/);
    expect(params[0]).toMatch(/broker unreachable/);
    expect(params[1]).toBe(7);
  });

  it('truncates a very long error message to 500 chars', async () => {
    const longMsg = 'e'.repeat(2000);
    const producer = { send: jest.fn().mockRejectedValue(new Error(longMsg)) };
    const pool = { query: jest.fn().mockResolvedValue({}) };

    await deliverOutboxRow({
      pool,
      producer,
      log: fakeLog(),
      compression: undefined,
      row: outboxRow(),
    });

    expect(pool.query.mock.calls[0][1][0].length).toBe(500);
  });

  it('does not throw even when the bookkeeping UPDATE itself fails', async () => {
    const producer = { send: jest.fn().mockRejectedValue(new Error('send fail')) };
    const pool = { query: jest.fn().mockRejectedValue(new Error('update fail')) };
    await expect(
      deliverOutboxRow({ pool, producer, log: fakeLog(), compression: undefined, row: outboxRow() })
    ).resolves.toBeUndefined();
  });
});

describe('pollOutboxOnce — full cycle', () => {
  /**
   * Route each SQL to a programmable response. The cycle issues, in order:
   *   stale-lock sweep, backlog gauge, notification gauge, claim, then a
   *   delivered/unlock UPDATE per claimed row. We match on SQL fragments.
   */
  function routedPool(handlers) {
    return {
      query: jest.fn(async (sql, params) => {
        for (const [re, resp] of handlers) {
          if (re.test(sql)) {
            return typeof resp === 'function' ? resp(sql, params) : resp;
          }
        }
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('refreshes both gauges and delivers each claimed row', async () => {
    const producer = { send: jest.fn().mockResolvedValue([]) };
    const outboxPendingGauge = fakeGauge();
    const notificationAttemptsGauge = fakeGauge();

    const pool = routedPool([
      [
        /SET locked_at = NULL, locked_by = NULL\s+WHERE delivered_at IS NULL AND locked_at IS NOT NULL/,
        {},
      ],
      [/SELECT topic, COUNT/, { rows: [{ topic: 'connection_events', n: 4 }] }],
      [/SELECT status, COUNT/, { rows: [{ status: 'failed', n: 2 }] }],
      [/FOR UPDATE SKIP LOCKED/, { rows: [outboxRow({ id: 11 }), outboxRow({ id: 12 })] }],
      [/SET delivered_at = NOW\(\)/, {}],
    ]);

    await pollOutboxOnce({
      pool,
      producer,
      log: fakeLog(),
      compression: undefined,
      batchSize: 50,
      lockTimeoutMs: 60000,
      workerId: 'w1',
      outboxPendingGauge,
      notificationAttemptsGauge,
    });

    // Both claimed rows published.
    expect(producer.send).toHaveBeenCalledTimes(2);
    // Per-topic backlog gauge reset + set.
    expect(outboxPendingGauge.reset).toHaveBeenCalled();
    expect(outboxPendingGauge.set).toHaveBeenCalledWith({ topic: 'connection_events' }, 4);
    // notification_attempts gauge reset + set.
    expect(notificationAttemptsGauge.reset).toHaveBeenCalled();
    expect(notificationAttemptsGauge.set).toHaveBeenCalledWith({ status: 'failed' }, 2);
  });

  it('returns early (no deliver) when the claim finds nothing', async () => {
    const producer = { send: jest.fn() };
    const pool = routedPool([[/FOR UPDATE SKIP LOCKED/, { rows: [] }]]);

    await pollOutboxOnce({
      pool,
      producer,
      log: fakeLog(),
      compression: undefined,
      batchSize: 50,
      lockTimeoutMs: 60000,
      workerId: 'w1',
      outboxPendingGauge: fakeGauge(),
      notificationAttemptsGauge: fakeGauge(),
    });

    expect(producer.send).not.toHaveBeenCalled();
  });

  it('logs and returns when the claim query itself throws (no crash)', async () => {
    const producer = { send: jest.fn() };
    const log = fakeLog();
    const pool = {
      query: jest.fn(async sql => {
        if (/FOR UPDATE SKIP LOCKED/.test(sql)) throw new Error('claim boom');
        return { rows: [] };
      }),
    };

    await expect(
      pollOutboxOnce({
        pool,
        producer,
        log,
        compression: undefined,
        batchSize: 50,
        lockTimeoutMs: 60000,
        workerId: 'w1',
        outboxPendingGauge: fakeGauge(),
        notificationAttemptsGauge: fakeGauge(),
      })
    ).resolves.toBeUndefined();

    expect(producer.send).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('Outbox claim failed:', 'claim boom');
  });
});

describe('startOutboxDrainer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs one cycle immediately, then on every interval, and stop() halts it', async () => {
    // Minimal pool whose claim returns nothing so each cycle is a quick no-op.
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const producer = { send: jest.fn() };

    const handle = startOutboxDrainer({
      pool,
      producer,
      log: fakeLog(),
      compression: undefined,
      intervalMs: 1000,
      batchSize: 50,
      lockTimeoutMs: 60000,
      workerId: 'w1',
      outboxPendingGauge: fakeGauge(),
      notificationAttemptsGauge: fakeGauge(),
    });

    // Immediate cycle fired at least one query (the stale-lock sweep).
    expect(pool.query).toHaveBeenCalled();
    const afterImmediate = pool.query.mock.calls.length;

    jest.advanceTimersByTime(1000);
    expect(pool.query.mock.calls.length).toBeGreaterThan(afterImmediate);
    const afterOneInterval = pool.query.mock.calls.length;

    handle.stop();
    jest.advanceTimersByTime(5000);
    // No further cycles after stop().
    expect(pool.query.mock.calls.length).toBe(afterOneInterval);

    // stop() is idempotent.
    expect(() => handle.stop()).not.toThrow();
  });
});
