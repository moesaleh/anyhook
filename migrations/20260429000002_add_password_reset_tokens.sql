-- Password reset tokens.
--
-- A user requesting a password reset gets a one-time token (raw value
-- returned in the API response in dev; production should email it).
-- The token is hashed at rest like API keys + invites. Used tokens are
-- marked with used_at so they can't be replayed.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prt_user_id ON password_reset_tokens(user_id);
CREATE INDEX idx_prt_token_hash ON password_reset_tokens(token_hash);
