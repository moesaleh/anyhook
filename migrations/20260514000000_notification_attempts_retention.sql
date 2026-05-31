-- P2-16: Bounded retention sweep for terminal notification_attempts.
--
-- notification_attempts (20260507000000) stores a full event snapshot as
-- JSONB per attempt and is never pruned — the same unbounded-growth shape
-- as delivery_events, at lower volume (only alert sends, not every
-- delivery). Once an attempt reaches a terminal state it is purely
-- historical:
--   * 'delivered' -> the alert landed.
--   * 'dlq'       -> retries exhausted; it will never be retried again.
-- Rows still 'pending' or 'failed' (and thus eligible for the retry
-- poller) are NEVER deleted here regardless of age, so an in-flight retry
-- chain is never truncated.
--
-- Mirrors prune_delivery_events from 20260510000000: a batched DELETE
-- driven by an external scheduler (cron / k8s CronJob / pg_cron), e.g.
-- daily:  SELECT prune_notification_attempts('90 days', 5000);
--
-- Up-only migration (matches the repo's node-pg-migrate SQL convention).

-- Supporting index for the sweep: terminal rows ordered by age. Partial
-- (only the deletable subset) so it stays tiny and the LIMIT/ORDER BY
-- batch claim is an index range scan, not a heap filter.
CREATE INDEX IF NOT EXISTS idx_notification_attempts_terminal
    ON notification_attempts (created_at)
    WHERE status IN ('delivered', 'dlq');

CREATE OR REPLACE FUNCTION prune_notification_attempts(
    p_retention INTERVAL DEFAULT INTERVAL '90 days',
    p_batch_size INTEGER DEFAULT 5000
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_cutoff   TIMESTAMPTZ := NOW() - p_retention;
    v_deleted  BIGINT := 0;
    v_batch    BIGINT := 0;
BEGIN
    LOOP
        WITH doomed AS (
            SELECT id
            FROM notification_attempts
            WHERE created_at < v_cutoff
              AND status IN ('delivered', 'dlq')
            ORDER BY created_at
            LIMIT p_batch_size
            FOR UPDATE SKIP LOCKED
        )
        DELETE FROM notification_attempts na
        USING doomed
        WHERE na.id = doomed.id;

        GET DIAGNOSTICS v_batch = ROW_COUNT;
        v_deleted := v_deleted + v_batch;
        EXIT WHEN v_batch = 0;
    END LOOP;

    RETURN v_deleted;
END;
$$;
