-- Per-organization overrides for rate limits and quotas.
--
-- NULL means "fall back to the env default" (ORG_MAX_SUBSCRIPTIONS,
-- ORG_MAX_API_KEYS, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SEC). Setting
-- a column to a number on a specific org overrides that default for that
-- org only — useful for upgrading paying customers, throttling abusive
-- ones, or whitelisting internal accounts.
--
-- These columns are NULLABLE by design. Adding NOT NULL with a fixed
-- default would couple the schema to the current default values, making
-- env-driven defaults impossible to change without DB writes.

ALTER TABLE organizations
  ADD COLUMN max_subscriptions INTEGER,
  ADD COLUMN max_api_keys INTEGER,
  ADD COLUMN rate_limit_requests INTEGER,
  ADD COLUMN rate_limit_window_sec INTEGER;
