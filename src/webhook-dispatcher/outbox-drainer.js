/**
 * Outbox drainer (extracted from the webhook-dispatcher entrypoint — P2-18).
 *
 * The /subscribe + /unsubscribe + PUT /subscriptions + bulk + admin-wipe
 * endpoints write their Kafka publishes into the outbox_events table inside
 * the same DB transaction that mutates the subscription. This module drains
 * that outbox to Kafka. A crash mid-publish leaves the row's locked_at stale;
 * the next sweep reclaims it via the lock-timeout — the same pattern used by
 * pending_retries.
 *
 * It runs in-process inside the dispatcher (started by index.js), NOT as a
 * separate worker — this is a pure cohesion refactor, behavior is unchanged.
 * The functions are exported individually so a test suite can drive a single
 * claim/deliver step without spinning up the interval loop.
 *
 * Multi-pod safe via FOR UPDATE SKIP LOCKED + locked_by tracking.
 */

/**
 * Claim a batch of undelivered, unlocked outbox rows atomically.
 *
 * Single statement: select up to `batchSize` due rows with FOR UPDATE SKIP
 * LOCKED (so concurrent pods never claim the same row) and stamp them
 * locked_at = NOW(), locked_by = us. Returns the claimed rows.
 */
async function claimDueOutbox({ pool, batchSize, workerId }) {
  const result = await pool.query(
    `WITH due AS (
        SELECT id FROM outbox_events
        WHERE delivered_at IS NULL AND locked_at IS NULL
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox_events o
     SET locked_at = NOW(), locked_by = $2
     FROM due
     WHERE o.id = due.id
     RETURNING o.*`,
    [batchSize, workerId]
  );
  return result.rows;
}

/**
 * Publish a single claimed outbox row to Kafka, then mark it delivered.
 *
 * On success → set delivered_at and clear the lock.
 * On failure → unlock + bump attempts + record last_error so the next sweep
 *              retries. Failures are logged, never thrown — one bad row must
 *              not abort the rest of the batch.
 */
async function deliverOutboxRow({ pool, producer, log, compression, row }) {
  try {
    await producer.send({
      topic: row.topic,
      // compression is undefined unless KAFKA_COMPRESSION is set, in which
      // case kafkajs treats it as CompressionTypes.None — same as the prior
      // behavior. Passing it here lets the durable outbox path benefit from
      // wire compression (P2-15) without changing message semantics.
      ...(compression !== undefined ? { compression } : {}),
      messages: [{ key: row.message_key, value: row.message_value }],
    });
    await pool.query(
      'UPDATE outbox_events SET delivered_at = NOW(), locked_at = NULL, locked_by = NULL WHERE id = $1',
      [row.id]
    );
  } catch (err) {
    log.error(`Outbox publish failed for row ${row.id}:`, err.message);
    // Unlock + bump attempts + record error. Next sweep retries.
    await pool
      .query(
        `UPDATE outbox_events
           SET locked_at = NULL, locked_by = NULL,
               attempts = attempts + 1, last_error = $1
         WHERE id = $2`,
        [String(err.message).slice(0, 500), row.id]
      )
      .catch(() => {});
  }
}

/**
 * One full drain cycle: stale-lock sweep + backlog gauges + claim + deliver.
 *
 * Hot loop:
 *   1. Stale-lock sweep: any undelivered row locked_at < now - lockTimeoutMs
 *      gets unlocked (a previous worker crashed mid-publish).
 *   2. Refresh the per-topic outbox backlog gauge + the notification_attempts
 *      pending gauge (cheap GROUP BYs; eventual consistency is fine).
 *   3. Claim a batch, then publish each row.
 */
async function pollOutboxOnce(deps) {
  const {
    pool,
    producer,
    log,
    compression,
    batchSize,
    lockTimeoutMs,
    workerId,
    outboxPendingGauge,
    notificationAttemptsGauge,
  } = deps;

  // Stale-lock sweep — fire and forget; if it fails we still try to claim.
  pool
    .query(
      `UPDATE outbox_events
       SET locked_at = NULL, locked_by = NULL
       WHERE delivered_at IS NULL AND locked_at IS NOT NULL
         AND locked_at < NOW() - ($1::text || ' milliseconds')::interval`,
      [String(lockTimeoutMs)]
    )
    .catch(err => log.error('Outbox stale-lock sweep failed:', err.message));

  // Update the per-topic backlog gauge. Cheap GROUP BY; runs every poll
  // cycle so the alert (outbox_pending_total > 100) sees fresh data.
  // Eventual consistency is fine for a metric.
  pool
    .query(
      `SELECT topic, COUNT(*)::int AS n
       FROM outbox_events
       WHERE delivered_at IS NULL
       GROUP BY topic`
    )
    .then(r => {
      outboxPendingGauge.reset();
      for (const row of r.rows) {
        outboxPendingGauge.set({ topic: row.topic }, row.n);
      }
    })
    .catch(() => {});

  // Same for notification_attempts — surfaces the "alerts pending retry"
  // signal that the dashboard / alerts can use.
  pool
    .query(
      `SELECT status, COUNT(*)::int AS n
       FROM notification_attempts
       WHERE status IN ('pending', 'failed')
       GROUP BY status`
    )
    .then(r => {
      notificationAttemptsGauge.reset();
      for (const row of r.rows) {
        notificationAttemptsGauge.set({ status: row.status }, row.n);
      }
    })
    .catch(() => {});

  let claimed;
  try {
    claimed = await claimDueOutbox({ pool, batchSize, workerId });
  } catch (err) {
    log.error('Outbox claim failed:', err.message);
    return;
  }
  if (claimed.length === 0) return;

  for (const row of claimed) {
    await deliverOutboxRow({ pool, producer, log, compression, row });
  }
}

/**
 * Start the outbox drainer interval. Runs pollOutboxOnce immediately and then
 * every `intervalMs`. Returns a handle with `.stop()` (clears the interval)
 * and `.pollOnce()` (run a single cycle, for tests / manual triggers).
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.producer            connected kafkajs producer
 * @param {object} deps.log                 logger
 * @param {object} deps.outboxPendingGauge  prom-client Gauge (labels: topic)
 * @param {object} deps.notificationAttemptsGauge prom-client Gauge (labels: status)
 * @param {number} deps.intervalMs
 * @param {number} deps.batchSize
 * @param {number} deps.lockTimeoutMs
 * @param {string} deps.workerId
 * @param {*}      [deps.compression]        kafkajs CompressionTypes value or undefined
 */
function startOutboxDrainer(deps) {
  const { intervalMs } = deps;
  // Bind deps once so the interval + pollOnce share the same closure.
  const runCycle = () => pollOutboxOnce(deps);

  let handle = setInterval(runCycle, intervalMs);
  // Run one cycle immediately so we don't wait the full interval after start.
  runCycle();

  return {
    pollOnce: runCycle,
    stop() {
      if (handle) {
        clearInterval(handle);
        handle = null;
      }
    },
  };
}

module.exports = {
  startOutboxDrainer,
  pollOutboxOnce,
  claimDueOutbox,
  deliverOutboxRow,
};
