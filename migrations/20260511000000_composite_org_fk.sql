-- P2-11: Tie the denormalized organization_id to its subscription's owner.
--
-- delivery_events and pending_retries each carry their own
-- organization_id (denormalized in 20260427000000 / 20260428000000 so
-- org dashboards don't have to JOIN through subscriptions). Nothing
-- enforces that this copy matches subscriptions.organization_id, so a
-- buggy/stale write could attribute a row to the WRONG tenant — and
-- since tenant isolation is "WHERE organization_id = $me", that is a
-- cross-tenant leak with no DB backstop.
--
-- Fix: a composite foreign key (subscription_id, organization_id) on both
-- child tables, referencing a matching UNIQUE on subscriptions. Now an
-- INSERT/UPDATE whose (sub, org) pair doesn't exist on the parent is
-- rejected — the denormalized value can only ever equal the real owner.
--
-- Existing single-column FKs to subscriptions(subscription_id) are kept
-- as-is (the ON DELETE CASCADE behavior lives on them); the composite FK
-- is purely an additional integrity guard and is created NO ACTION so it
-- doesn't double up cascade semantics.
--
-- SAFETY: the children were backfilled from subscriptions, so the data
-- should already be consistent. We still add the composite FKs NOT VALID
-- first (instant, no full-table scan / no ACCESS EXCLUSIVE lock held over
-- a scan) and VALIDATE them in a second step. VALIDATE takes only a
-- SHARE UPDATE EXCLUSIVE lock (writes continue) and fails LOUDLY if any
-- pre-existing row is inconsistent, so an operator can fix the data
-- rather than the migration silently passing. New rows are checked
-- immediately on INSERT regardless of validation state.
--
-- Up-only migration (matches the repo's node-pg-migrate SQL convention).

-- Parent-side UNIQUE the composite FKs reference. subscription_id is
-- already the PRIMARY KEY (so already unique), but a composite FK needs a
-- UNIQUE/PK on exactly (subscription_id, organization_id). Guarded so a
-- re-run / fresh schema is idempotent.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'subscriptions_sub_org_uniq'
          AND conrelid = 'subscriptions'::regclass
    ) THEN
        ALTER TABLE subscriptions
            ADD CONSTRAINT subscriptions_sub_org_uniq
            UNIQUE (subscription_id, organization_id);
    END IF;
END
$$;

-- delivery_events composite FK.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'delivery_events_sub_org_fkey'
          AND conrelid = 'delivery_events'::regclass
    ) THEN
        ALTER TABLE delivery_events
            ADD CONSTRAINT delivery_events_sub_org_fkey
            FOREIGN KEY (subscription_id, organization_id)
            REFERENCES subscriptions (subscription_id, organization_id)
            NOT VALID;
    END IF;
END
$$;

ALTER TABLE delivery_events
    VALIDATE CONSTRAINT delivery_events_sub_org_fkey;

-- pending_retries composite FK.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pending_retries_sub_org_fkey'
          AND conrelid = 'pending_retries'::regclass
    ) THEN
        ALTER TABLE pending_retries
            ADD CONSTRAINT pending_retries_sub_org_fkey
            FOREIGN KEY (subscription_id, organization_id)
            REFERENCES subscriptions (subscription_id, organization_id)
            NOT VALID;
    END IF;
END
$$;

ALTER TABLE pending_retries
    VALIDATE CONSTRAINT pending_retries_sub_org_fkey;
