-- Transactional outbox for Kafka publishing.
--
-- The /subscribe, /subscribe/bulk, PUT /subscriptions/:id, /unsubscribe,
-- and admin DELETE /subscriptions endpoints all do the same dance:
--   1. write to Postgres (subscriptions table)
--   2. set / delete in Redis
--   3. publish to a Kafka topic
-- A Kafka publish failure after step 1 leaves Postgres ahead of the
-- connector / dispatcher; the prior fix in commits 9a097e0 + e0c6a8f
-- mostly returned 500 to surface it, but the underlying row was still
-- in the DB and the connector still didn't open.
--
-- This table is the buffer: handlers INSERT into outbox_events INSIDE
-- the same transaction that writes the subscription row, then commit.
-- A worker (in webhook-dispatcher) drains the outbox: claims pending
-- rows under FOR UPDATE SKIP LOCKED, publishes to Kafka, marks
-- delivered_at on success. Crash mid-publish leaves the row
-- locked_at-stale; the next sweep reclaims it via the timeout — same
-- pattern as pending_retries.
--
-- Guarantees:
--   - At-least-once Kafka publish: a transaction commit means the
--     Kafka publish WILL happen eventually.
--   - No Kafka failures block the API path: handlers always return 2xx
--     on a successful DB write; downstream consumers see the event
--     once the outbox worker drains it.
--   - The connector + dispatcher's existing event_id idempotency check
--     and Redis cache make duplicate publishes safe.

CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic TEXT NOT NULL,
    -- message_key is what kafkajs uses for partition assignment.
    -- For subscription events this is the subscription_id so the
    -- same-sub-same-partition guarantee survives the outbox.
    message_key TEXT,
    message_value TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMP WITH TIME ZONE,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    locked_at TIMESTAMP WITH TIME ZONE,
    locked_by TEXT
);

-- Hot path: "what's pending and unclaimed". Partial index because
-- delivered + locked rows aren't worth scanning.
CREATE INDEX idx_outbox_pending
    ON outbox_events (created_at)
    WHERE delivered_at IS NULL AND locked_at IS NULL;

-- Stale-lock sweep: "anything still locked from a crashed worker".
CREATE INDEX idx_outbox_stuck
    ON outbox_events (locked_at)
    WHERE locked_at IS NOT NULL AND delivered_at IS NULL;
