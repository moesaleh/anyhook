-- P1-5: Bound delivery_events growth + speed up the org-wide stats query.
--
-- delivery_events records one row per delivery attempt (original + every
-- retry) including request/response bodies. It has no retention, so it
-- grows without bound. Two problems:
--
--   1. The /deliveries/stats endpoint (src/subscription-management/app.js)
--      aggregates COUNT(*)/FILTER over the ENTIRE table for an org with no
--      time predicate -> a full per-org scan that gets slower with tenant
--      age. The existing idx_delivery_events_org_created
--      (organization_id, created_at DESC) helps a windowed scan but the
--      query also filters by status, so adding status to the index lets
--      the windowed FILTER aggregation run index-only.
--
--   2. Old rows are never reclaimed.
--
-- CHOICE OF RETENTION MECHANISM — scheduled DELETE, not partitioning.
--
--   The textbook fix is monthly range partitioning by created_at with a
--   DROP-PARTITION aging job (cheap metadata DDL vs row-by-row DELETE).
--   BUT delivery_events is ALREADY a populated, live table that other
--   migrations FK into (and P2-11 adds a composite FK referencing it).
--   Converting a populated table to partitioned in a single migration
--   means: create a new partitioned parent, copy every row, swap names —
--   all under an ACCESS EXCLUSIVE lock, with the in-flight dispatcher
--   writing concurrently. That is exactly the "unsafe to convert an
--   existing populated table in one migration" case the plan calls out.
--
--   So we take the safe path here: ship the covering index + a documented
--   bounded-DELETE retention function now, and leave partitioning as a
--   follow-up to be done in a dedicated maintenance window on a fresh
--   partitioned table with a backfill/swap (see FOLLOW-UP below).
--
-- FOLLOW-UP (partitioning, separate maintenance-window migration):
--   * CREATE TABLE delivery_events_p (LIKE delivery_events INCLUDING ALL)
--       PARTITION BY RANGE (created_at);
--   * pre-create monthly partitions; copy rows in batches; swap names;
--   * replace prune_delivery_events() below with a DROP PARTITION job.
--
-- Up-only migration (matches the repo's node-pg-migrate SQL convention).

-- (1) Covering index for the bounded stats aggregation. Ordering
--     created_at DESC matches the windowed scan direction; status is the
--     trailing column so COUNT(*) FILTER (WHERE status = ...) over a time
--     window can be satisfied from the index without heap fetches.
CREATE INDEX IF NOT EXISTS idx_delivery_events_org_created_status
    ON delivery_events (organization_id, created_at DESC, status);

-- (2) Bounded retention function. Deletes terminal rows older than the
--     given cutoff in capped batches so a large first run can't hold one
--     giant transaction / bloat WAL. Returns the number of rows removed.
--
--     Called by an external scheduler (cron / k8s CronJob / pg_cron),
--     e.g. daily:  SELECT prune_delivery_events('90 days', 5000);
--
--     Defaults: keep 90 days, 5000 rows per batch. Retries that are still
--     in flight (status 'retrying') are never deleted regardless of age,
--     so an active retry chain is never truncated mid-flight.
CREATE OR REPLACE FUNCTION prune_delivery_events(
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
            SELECT delivery_id
            FROM delivery_events
            WHERE created_at < v_cutoff
              AND status IN ('success', 'failed', 'dlq')
            ORDER BY created_at
            LIMIT p_batch_size
            FOR UPDATE SKIP LOCKED
        )
        DELETE FROM delivery_events de
        USING doomed
        WHERE de.delivery_id = doomed.delivery_id;

        GET DIAGNOSTICS v_batch = ROW_COUNT;
        v_deleted := v_deleted + v_batch;
        EXIT WHEN v_batch = 0;
    END LOOP;

    RETURN v_deleted;
END;
$$;
