-- Multi-tenancy: organizations, users, memberships, api_keys.
-- Scope subscriptions and delivery_events by organization_id.
--
-- Existing rows are backfilled into a deterministic "Default" organization
-- so the system stays functional during the migration. The Default org has
-- no members; the first registered user can be added to it manually if
-- the existing data needs to be claimed.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    -- scrypt$<salt_hex>$<hash_hex>
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS memberships (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')) DEFAULT 'member',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, organization_id)
);

CREATE INDEX idx_memberships_user_id ON memberships(user_id);
CREATE INDEX idx_memberships_organization_id ON memberships(organization_id);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- First 8 chars of the raw key (e.g. "ak_a1b2c3"), shown in UI for ID.
    key_prefix TEXT NOT NULL,
    -- SHA-256 hex of the raw key. Lookups hash the incoming bearer and
    -- match here. The raw value is shown to the user ONLY at creation.
    key_hash TEXT NOT NULL UNIQUE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_organization_id ON api_keys(organization_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

-- Default org for backfilled existing data
INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'default')
ON CONFLICT (slug) DO NOTHING;

-- Scope subscriptions
ALTER TABLE subscriptions
    ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

UPDATE subscriptions
SET organization_id = '00000000-0000-0000-0000-000000000001'
WHERE organization_id IS NULL;

ALTER TABLE subscriptions
    ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX idx_subscriptions_organization_id ON subscriptions(organization_id);

-- Scope delivery_events. Denormalized — could JOIN through subscriptions
-- but having organization_id directly cuts query plans for org dashboards.
ALTER TABLE delivery_events
    ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

UPDATE delivery_events de
SET organization_id = s.organization_id
FROM subscriptions s
WHERE de.subscription_id = s.subscription_id
  AND de.organization_id IS NULL;

ALTER TABLE delivery_events
    ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX idx_delivery_events_org_created ON delivery_events(organization_id, created_at DESC);
