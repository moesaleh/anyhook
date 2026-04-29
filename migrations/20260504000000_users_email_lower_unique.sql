-- Replace the case-sensitive UNIQUE on users.email with a UNIQUE
-- functional index on LOWER(email).
--
-- Original schema: `email TEXT NOT NULL UNIQUE`. Application code
-- already uses LOWER(email) = LOWER($1) for lookups and stores newly
-- registered emails lowercased -- but a deployment that ran before
-- normalization landed could legitimately have both `Foo@bar.com` and
-- `foo@bar.com` in the table, and the case-sensitive UNIQUE wouldn't
-- have caught it. After this migration the constraint is on the
-- normalised form, so duplicates by case become DB-level errors.
--
-- Backwards-compat: existing rows that already differ only in case
-- would block this migration. We refuse to silently delete the user;
-- the migration fails loudly so an operator can decide who to keep.

-- Drop the bare-column UNIQUE constraint Postgres named
-- `users_email_key` by default. IF EXISTS so a future fresh schema
-- (already on the new layout) can re-run idempotently.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

-- Functional unique index on the lowered form. CREATE UNIQUE INDEX
-- (not UNIQUE constraint) because Postgres can't enforce UNIQUE
-- constraints on function expressions directly.
CREATE UNIQUE INDEX users_email_lower_uniq ON users (LOWER(email));

-- The previous non-unique index was idx_users_email_lower (created in
-- migration 20260427000000). Drop it -- the new unique index covers
-- the same lookup pattern.
DROP INDEX IF EXISTS idx_users_email_lower;
