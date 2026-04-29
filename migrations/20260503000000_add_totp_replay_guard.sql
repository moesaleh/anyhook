-- users.last_totp_step — closes the TOTP code-replay window.
--
-- TOTP verification accepts ±1 step (30s) of clock skew, so a code
-- accepted at second 31 is still valid at second 60. Without a
-- "highest used step" record, the same code could be replayed inside
-- that ~90s window. We track the step counter that just succeeded
-- and reject any code whose step is <= that value.
--
-- Persists across login + 2FA-disable + 2FA-verify-setup paths.
-- BIGINT because the step counter is `epoch_seconds / 30`, which fits
-- in INT until ~year 4047 but BIGINT future-proofs it.

ALTER TABLE users
    ADD COLUMN last_totp_step BIGINT;
