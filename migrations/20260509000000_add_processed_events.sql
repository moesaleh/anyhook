-- P1-4: Atomic delivery idempotency gate (processed_events).
--
-- The webhook-dispatcher currently dedups Kafka redeliveries with a
-- SELECT-then-(maybe)-INSERT against delivery_events
-- (src/webhook-dispatcher/index.js around the "Idempotency:" comment).
-- That check-then-act has a race: two pods (or a rebalance redelivery
-- racing the original) can both run the SELECT, both see zero rows, and
-- both start a parallel retry chain -> the endpoint is double-fired.
--
-- We CANNOT enforce this with a UNIQUE on delivery_events itself: that
-- table legitimately holds many rows per (subscription_id, event_id) —
-- one per attempt (original + every retry + the terminal dlq/success
-- row). A UNIQUE there would reject the second attempt and break retries.
--
-- Instead this introduces a dedicated, single-row-per-event idempotency
-- table. The dispatcher claims an event by:
--
--     INSERT INTO processed_events (subscription_id, event_id, organization_id)
--     VALUES ($1, $2, $3)
--     ON CONFLICT DO NOTHING;
--     -- rowCount === 0  => someone else already owns this event; skip.
--     -- rowCount === 1  => we won the race; proceed with delivery.
--
-- The PRIMARY KEY does the work — the conflict-or-insert is atomic, so
-- exactly one caller proceeds regardless of concurrency. delivery_events
-- keeps recording every attempt as before.
--
-- Kept deliberately narrow (no payload/response bodies) so the insert is
-- a single cheap index write on the hot delivery path.
--
-- ON DELETE CASCADE on subscription_id mirrors delivery_events: deleting
-- a subscription clears its idempotency markers too. organization_id is
-- nullable + denormalized for tenant-scoped retention/auditing only; it
-- is NOT part of the dedup key (the (subscription_id, event_id) pair is
-- globally unique on its own).
--
-- Up-only migration (matches the repo's node-pg-migrate SQL convention).

CREATE TABLE IF NOT EXISTS processed_events (
    subscription_id UUID NOT NULL
        REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subscription_id, event_id)
);

-- Supports tenant-scoped cleanup / aging of old idempotency markers
-- (e.g. "delete processed_events for org X older than N days") without
-- a full scan. Partial-free because organization_id can be NULL only for
-- pre-multi-tenancy rows, which won't exist for fresh inserts.
CREATE INDEX IF NOT EXISTS idx_processed_events_org_time
    ON processed_events (organization_id, processed_at);
