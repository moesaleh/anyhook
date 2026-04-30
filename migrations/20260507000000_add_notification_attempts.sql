-- Track every notification dispatch attempt + outcome.
--
-- The webhook-dispatcher fires email + Slack alerts for events
-- (currently only DLQ) via lib/notifications.js. Until now those
-- sends were fire-and-forget — a Slack outage or transient SMTP
-- failure dropped the alert silently. This table records every
-- attempt so:
--   - operators can see whether alerts actually landed
--   - failed attempts can be retried with exponential backoff
--   - the dashboard can surface "alerts pending retry"
--
-- A row's lifecycle:
--   created  → status='pending', attempt=1
--   on send → status updated to 'delivered' OR 'failed'
--             attempts incremented
--             last_error captured on failure
--   if status='failed' AND attempts < max_attempts (5),
--     a retry poller picks it up after backoff
--   max attempts exhausted → status='dlq' (informational; the
--     alert won't be retried again)

CREATE TABLE IF NOT EXISTS notification_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- Foreign key to the prefer; nullable so an attempt isn't lost if
    -- the operator deletes the prefs row mid-retry.
    preference_id UUID REFERENCES notification_preferences(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'slack')),
    destination TEXT NOT NULL,
    event_name TEXT NOT NULL,
    -- Snapshot of what was sent — JSON so we can re-issue on retry
    -- without re-reading the original event from somewhere.
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'failed', 'dlq')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMP WITH TIME ZONE,
    locked_at TIMESTAMP WITH TIME ZONE,
    locked_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_attempts_org
    ON notification_attempts(organization_id, created_at DESC);

-- Hot path for the retry poller: "what's pending or failed-but-not-
-- exhausted, due to retry, and unclaimed?"
CREATE INDEX idx_notification_attempts_due
    ON notification_attempts(next_attempt_at)
    WHERE status IN ('pending', 'failed') AND locked_at IS NULL;

-- Stale-lock sweep.
CREATE INDEX idx_notification_attempts_locked
    ON notification_attempts(locked_at)
    WHERE locked_at IS NOT NULL;
