-- 2FA via TOTP (RFC 6238) + single-use backup codes.
--
-- Two-step enrollment:
--   1. POST /auth/2fa/setup writes totp_secret (PENDING — not yet active).
--   2. POST /auth/2fa/verify-setup verifies a code against the pending
--      secret, sets totp_enabled_at, generates and returns 10 backup codes.
--
-- Login flow when 2FA is enabled:
--   - /auth/login returns { needs_2fa: true, pending_token }, no cookie.
--   - /auth/2fa/verify-login redeems the pending token + a TOTP code OR
--     a backup code, sets the session cookie, completes the login.

ALTER TABLE users
    -- Base32-encoded TOTP shared secret. Stored in plaintext for now;
    -- a future change should encrypt with a KMS-backed envelope key.
    ADD COLUMN totp_secret TEXT,
    -- Set the moment 2FA is verified during enrollment. NULL means a
    -- secret may exist (pending) but 2FA is not yet enforced.
    ADD COLUMN totp_enabled_at TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS backup_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 hex of the raw code. Raw shown ONCE at enrollment.
    code_hash TEXT NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backup_codes_user_id ON backup_codes(user_id);
-- Partial index: lookup-by-hash only matters for unused codes.
CREATE INDEX idx_backup_codes_unused
    ON backup_codes(code_hash) WHERE used_at IS NULL;
