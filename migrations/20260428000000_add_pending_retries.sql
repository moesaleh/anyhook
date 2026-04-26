-- Persistent retry queue for the webhook dispatcher.
--
-- Replaces the in-process setTimeout model. Each entry represents a
-- delivery that needs to be re-attempted at a specific time. The dispatcher
-- polls this table on a short interval, claims due rows with FOR UPDATE
-- SKIP LOCKED, processes them, and re-schedules or deletes.
--
-- Survives restarts: a process crash leaves rows in place. A locked row
-- whose locked_at is older than the lock timeout is reclaimed by the next
-- poll cycle (see src/webhook-dispatcher/index.js).
--
-- Multi-pod safe: SKIP LOCKED ensures two dispatcher pods never claim the
-- same retry. locked_by records the worker for debugging.

CREATE TABLE IF NOT EXISTS pending_retries (
    event_id UUID PRIMARY KEY,
    subscription_id UUID NOT NULL
        REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
    organization_id UUID NOT NULL
        REFERENCES organizations(id) ON DELETE CASCADE,
    -- Snapshot of the payload from the source. Webhook URL + secret are
    -- looked up from Redis at retry time so that subscription edits take
    -- effect on subsequent retries (and deleted subs vanish via the FK).
    request_body TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL,
    locked_at TIMESTAMP WITH TIME ZONE,
    locked_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- The hot path query: "what's due and unclaimed". Partial index because
-- locked rows are skipped; a covering index on the subset is much smaller
-- than a full index.
CREATE INDEX idx_pending_retries_due
    ON pending_retries (next_attempt_at)
    WHERE locked_at IS NULL;

-- For the stale-lock sweep: "anything still locked from a crashed worker".
CREATE INDEX idx_pending_retries_locked_at
    ON pending_retries (locked_at)
    WHERE locked_at IS NOT NULL;
