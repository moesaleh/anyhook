-- Create delivery_events table for webhook delivery tracking
-- Each row represents a single delivery attempt (original or retry)
-- event_id groups the original attempt with its retries

CREATE TABLE IF NOT EXISTS delivery_events (
    delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
    event_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'failed', 'retrying', 'dlq')),
    http_status_code INTEGER,
    response_time_ms INTEGER,
    payload_size_bytes INTEGER,
    request_body TEXT,
    response_body TEXT,
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fetching delivery history per subscription (most common query)
CREATE INDEX idx_delivery_events_subscription_id ON delivery_events(subscription_id, created_at DESC);

-- Index for grouping retries by event
CREATE INDEX idx_delivery_events_event_id ON delivery_events(event_id);

-- Index for filtering by status
CREATE INDEX idx_delivery_events_status ON delivery_events(status);

-- Index for time-range queries (24h, 7d stats)
CREATE INDEX idx_delivery_events_created_at ON delivery_events(created_at DESC);
