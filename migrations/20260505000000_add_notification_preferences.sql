-- Per-org notification preferences for delivery-failure alerts.
--
-- An org owner/admin registers one or more channels (email or Slack
-- incoming-webhook URL); when the dispatcher emits a `dlq` delivery
-- event, it fans out to every enabled preference for that org.
--
-- `events` is left as TEXT[] so we can grow the alert taxonomy later
-- (e.g. 'connection_drop', 'quota_warning') without another schema
-- change. For now only 'dlq' is wired.

CREATE TABLE IF NOT EXISTS notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'slack')),
    -- For 'email' this is a single recipient; for 'slack' it's an
    -- incoming-webhook URL. The destination is validated at the API
    -- layer (email format / SSRF-safe URL) before INSERT.
    destination TEXT NOT NULL,
    events TEXT[] NOT NULL DEFAULT ARRAY['dlq']::TEXT[],
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_preferences_org
    ON notification_preferences(organization_id);

-- Lookup hot path on the dispatcher: "all enabled prefs for this
-- org that subscribe to a given event". Partial index on enabled=true
-- because disabled rows aren't worth scanning.
CREATE INDEX idx_notification_preferences_active
    ON notification_preferences(organization_id)
    WHERE enabled = TRUE;
