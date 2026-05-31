-- P2-26: Post-deploy verification of the email_lower_unique transition.
--
-- 20260504000000 replaced the case-sensitive UNIQUE on users.email with a
-- functional UNIQUE index on LOWER(email). It removed the old objects with
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
--   DROP INDEX IF EXISTS idx_users_email_lower;
-- Both DROPs rely on the DEFAULT object names Postgres assigns. If an
-- environment's original `email TEXT NOT NULL UNIQUE` constraint was ever
-- materialised under a NON-default name (e.g. restored from a dump, or
-- created by an older hand-written DDL), the IF EXISTS DROP is a silent
-- no-op and the stale case-sensitive UNIQUE lingers — defeating the
-- case-insensitive guarantee and allowing Foo@bar.com + foo@bar.com.
--
-- This migration is NON-DESTRUCTIVE: it only inspects the catalog and
-- fails LOUDLY (RAISE EXCEPTION) if the transition is incomplete, so a
-- broken environment is caught at deploy time instead of leaking dup
-- accounts later. It changes no data and no schema.
--
-- Up-only migration (matches the repo's node-pg-migrate SQL convention).

DO $$
DECLARE
    v_has_lower_uniq  BOOLEAN;
    v_stray_email_uc  TEXT;
    v_stale_idx       BOOLEAN;
BEGIN
    -- (a) The new functional unique index must be present — confirms
    --     20260504000000 actually ran in this environment.
    SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'i'
          AND c.relname = 'users_email_lower_uniq'
    ) INTO v_has_lower_uniq;

    IF NOT v_has_lower_uniq THEN
        RAISE EXCEPTION
            'email_lower_unique transition incomplete: expected unique index '
            '"users_email_lower_uniq" is missing (did 20260504000000 run?).';
    END IF;

    -- (b) No UNIQUE constraint keyed on exactly the plain (email) column
    --     may remain — under ANY name, not just the default users_email_key.
    --     pg_constraint.conkey is the array of attnums; we match a single
    --     'u'-type constraint whose one column is users.email.
    SELECT con.conname INTO v_stray_email_uc
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'users'::regclass
      AND con.contype = 'u'
      AND cardinality(con.conkey) = 1
      AND att.attname = 'email'
    LIMIT 1;

    IF v_stray_email_uc IS NOT NULL THEN
        RAISE EXCEPTION
            'email_lower_unique transition incomplete: a case-sensitive '
            'UNIQUE constraint on users(email) still exists as "%". Drop it '
            'manually, e.g. ALTER TABLE users DROP CONSTRAINT %I;',
            v_stray_email_uc, v_stray_email_uc;
    END IF;

    -- (c) The superseded non-unique index idx_users_email_lower must be
    --     gone (the new unique index covers the same lookup). Default name,
    --     so a simple presence check is sufficient.
    SELECT EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.relkind = 'i'
          AND c.relname = 'idx_users_email_lower'
    ) INTO v_stale_idx;

    IF v_stale_idx THEN
        RAISE EXCEPTION
            'email_lower_unique transition incomplete: superseded index '
            '"idx_users_email_lower" still exists; drop it manually with '
            'DROP INDEX idx_users_email_lower;';
    END IF;

    RAISE NOTICE
        'email_lower_unique transition verified: users_email_lower_uniq '
        'present; no stray UNIQUE(email) constraint; idx_users_email_lower '
        'absent.';
END
$$;
