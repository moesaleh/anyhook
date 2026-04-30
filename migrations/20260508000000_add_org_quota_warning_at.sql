-- Cooldown column for quota_warning notifications.
--
-- The subscriptionQuota middleware fires a quota_warning notification
-- when an org crosses 80% of its subscription cap. Without a cooldown,
-- every subsequent /subscribe call would re-fire the alert -- noisy
-- and useless. We claim the warning slot atomically by UPDATE'ing
-- last_quota_warning_at to NOW() only when its current value is NULL
-- OR older than 1 hour; the UPDATE's RETURNING rowCount tells us
-- whether THIS request "won" the slot.
--
-- Resetting (e.g. after an operator raises the cap) is implicit:
-- once usage drops below 80% the dispatch path doesn't fire, and the
-- next breach 1h+ later wins the slot again.

ALTER TABLE organizations
    ADD COLUMN last_quota_warning_at TIMESTAMP WITH TIME ZONE;
