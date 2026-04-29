-- Widen subscriptions.webhook_url and .connection_type from VARCHAR(255)
-- to TEXT.
--
-- Real-world webhook URLs (signed S3 / Lambda function URLs, Slack
-- webhooks with rotating tokens, OAuth-bearer query strings) routinely
-- exceed 255 chars. The original schema rejected those at INSERT with
-- a generic 500. TEXT in Postgres has no per-row length penalty over
-- VARCHAR(N) and removes the artificial cap.
--
-- connection_type is also widened from VARCHAR(255) to TEXT for
-- symmetry; the application already constrains it to a small enum
-- ('graphql', 'websocket') at the API layer.
--
-- ALTER TYPE on these columns is metadata-only (no table rewrite) for
-- VARCHAR(N) → TEXT and VARCHAR(N) → VARCHAR(M>N) since Postgres
-- stores both as varlena. Should run in milliseconds even on a large
-- subscriptions table.

ALTER TABLE subscriptions
    ALTER COLUMN webhook_url TYPE TEXT,
    ALTER COLUMN connection_type TYPE TEXT;
