-- P2-13: Document the users.totp_secret at-rest encryption transition.
--
-- BACKGROUND. The TOTP shared secret in users.totp_secret was stored as
-- Base32 plaintext (see 20260430000000, whose own comment flagged the TODO
-- to encrypt it). The encryption is now wired in the auth path using
-- src/lib/envelope.js (AES-256-GCM), NOT in this migration:
--
--   * encrypt() with TOTP_SECRET_KEY set -> writes
--       enc:v1:<iv>:<ciphertext>:<tag>   (an opaque ASCII string).
--   * encrypt() with NO key set          -> passes the plaintext through
--       unchanged (dev/test stays simple).
--   * decrypt() recognises the enc:v1: prefix and transparently upgrades
--       legacy plaintext rows on first verify (returns neededRotation).
--
-- WHY NO SCHEMA CHANGE TO totp_secret IS NEEDED. The ciphertext is just a
-- longer ASCII string and totp_secret is already TEXT (unbounded), so the
-- envelope output fits with no column rename, widening, or type change.
-- The transition is therefore data-only and happens lazily as users
-- re-enroll / verify; this migration deliberately rewrites NO rows.
--
-- BACKWARD COMPATIBILITY. Mixed plaintext + ciphertext rows coexist
-- safely during the rollout window: decrypt() distinguishes them by the
-- enc:v1: prefix. No backfill is required (and forcing one would need the
-- key in the DB layer, which we avoid).
--
-- KEY ROTATION HELPER (optional, additive). envelope.js supports rotation
-- via TOTP_SECRET_KEY + TOTP_SECRET_KEY_OLD, trying the current key then
-- the old one on decrypt. That works without any per-row metadata, but
-- recording WHICH key encrypted a row makes a rotation sweep observable
-- ("how many rows still on the old key id?") and lets a future scheme
-- support more than two concurrent keys. We add a nullable column for
-- that bookkeeping; it is purely informational and may stay NULL:
--   * NULL                -> legacy plaintext OR key id not tracked.
--   * a short label/id     -> the key generation that produced the
--                             ciphertext currently stored (set by the
--                             auth path when/if it chooses to populate it).
--
-- Up-only migration (matches the repo's node-pg-migrate SQL convention).

-- Idempotent add. ADD COLUMN of a nullable column with no default is a
-- metadata-only change (no table rewrite) on modern Postgres.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS totp_secret_enc_keyid TEXT;

-- Refresh the inline documentation on the secret column so anyone reading
-- the catalog (\d+ users) sees the current at-rest story rather than the
-- stale "plaintext for now" note.
COMMENT ON COLUMN users.totp_secret IS
    'Base32 TOTP secret, encrypted at rest via src/lib/envelope.js '
    '(enc:v1:<iv>:<ct>:<tag>) when TOTP_SECRET_KEY is set; legacy '
    'plaintext rows are upgraded transparently on first verify. Fits TEXT, '
    'no rename needed.';

COMMENT ON COLUMN users.totp_secret_enc_keyid IS
    'Optional: identifier of the envelope key generation that produced the '
    'current totp_secret ciphertext, for rotation bookkeeping. NULL = '
    'untracked or legacy plaintext. See src/lib/envelope.js rotation notes.';
