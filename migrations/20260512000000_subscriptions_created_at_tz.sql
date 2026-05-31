-- P2-12: Migrate legacy subscriptions.created_at to TIMESTAMPTZ.
--
-- The original subscriptions table (20240930142437) declared
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- i.e. "timestamp WITHOUT time zone". Every other table created since
-- uses "TIMESTAMP WITH TIME ZONE" (timestamptz). The bare TIMESTAMP loses
-- the offset, so ordering and INTERVAL math against now() are ambiguous
-- and can be off by the server's tz — a latent correctness bug for the
-- dashboards that sort/window subscriptions by created_at.
--
-- !!! MAINTENANCE WINDOW: this is a COLUMN REWRITE. ALTER COLUMN ... TYPE
-- rewrites every row and holds an ACCESS EXCLUSIVE lock on subscriptions
-- for the duration, blocking reads and writes. Run it in a low-traffic
-- window. (subscriptions is small relative to delivery_events, so the
-- rewrite is short, but it is NOT a metadata-only change.)
--
-- The existing values were written by CURRENT_TIMESTAMP on a server
-- assumed to run in UTC (the deployment standard), so we reinterpret the
-- naive wall-clock as UTC:  created_at AT TIME ZONE 'UTC'  yields the
-- equivalent timestamptz. If your historical data was written in a
-- non-UTC server zone, change 'UTC' below to that zone before running.
--
-- Up-only migration (matches the repo's node-pg-migrate SQL convention).

-- Type conversion. Guarded so a fresh schema that is somehow already on
-- timestamptz (or a re-run) is a no-op rather than an error.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'subscriptions'
          AND column_name = 'created_at'
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE subscriptions
            ALTER COLUMN created_at TYPE TIMESTAMP WITH TIME ZONE
            USING created_at AT TIME ZONE 'UTC';
    END IF;
END
$$;

-- Re-assert the default explicitly. CURRENT_TIMESTAMP is already
-- timestamptz, so this keeps the column's default consistent with its new
-- type and with the rest of the schema's NOW()/CURRENT_TIMESTAMP defaults.
ALTER TABLE subscriptions
    ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

-- The original subscription_id PRIMARY KEY has no default (rows always
-- supply an explicit UUID from the app). Add gen_random_uuid() for
-- symmetry with every other table's id column, so a manual/admin INSERT
-- that omits it still gets a valid key. Additive and backward compatible:
-- app inserts that pass an explicit id are unaffected. pgcrypto (which
-- provides gen_random_uuid) was enabled in 20260427000000.
ALTER TABLE subscriptions
    ALTER COLUMN subscription_id SET DEFAULT gen_random_uuid();
