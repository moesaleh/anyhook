-- Email-based invitation flow.
--
-- An invitation is a one-time token that lets an unauthenticated user
-- create an account pre-attached to an organization with a chosen role.
-- The raw token is shown once at create time (like API keys); only its
-- SHA-256 hash is stored. Tokens expire after expires_at and become
-- unusable once accepted_at or revoked_at is set.
--
-- Existing users wanting to join an org should still be added via
-- POST /organizations/current/members — the invitation flow targets the
-- "no account yet" case.

CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')) DEFAULT 'member',
    -- SHA-256 hex of the raw invite token. UNIQUE so a duplicate insert
    -- (collision in random bytes) errors loudly instead of silently
    -- overwriting another org's invite.
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invitations_organization_id ON invitations(organization_id);
CREATE INDEX idx_invitations_token_hash ON invitations(token_hash);
CREATE INDEX idx_invitations_email_lower ON invitations (LOWER(email));
