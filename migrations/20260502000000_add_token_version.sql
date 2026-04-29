-- users.token_version — server-side bump-counter that invalidates all
-- existing session JWTs.
--
-- The session JWT carries `tv` = the user's token_version at sign time.
-- requireAuth() compares the JWT's `tv` to the current value in the
-- users row on every authenticated request; mismatch = 401 (treated as
-- "expired session").
--
-- We bump token_version on:
--   - logout              (clean cookie clear AND server-side invalidation)
--   - password change     (rotate so old cookies stop working)
--   - password reset      (same)
--   - 2FA disable         (the verification fence is gone — re-auth needed)
--
-- This closes a gap where a leaked / stolen cookie remained valid for
-- the full 7-day expiry regardless of what the user did.

ALTER TABLE users
    ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
