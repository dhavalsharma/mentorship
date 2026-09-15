-- The two roles the tenancy design assumes, created only if absent.
--
-- 0002_rls.sql says roles belong to provisioning rather than to a migration,
-- and that is still true: this creates them NOLOGIN and passwordless, so it
-- cannot conflict with a managed role your platform already owns, and it is a
-- no-op when they exist. What it buys is that `docker compose up` followed by
-- `pnpm db:migrate` produces a database where RLS can actually be exercised —
-- otherwise the only role available locally is the superuser, which bypasses
-- every policy, and the isolation guarantee is untested folklore.
--
-- Production provisioning grants LOGIN and a password, and the application's
-- DATABASE_URL connects as mentorship_app. Locally the connection is the
-- superuser, so `withTenant(db, orgId, fn, { role: "mentorship_app" })` is how
-- a dev or a test drops into the unprivileged role and gets the real policy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mentorship_admin') THEN
    CREATE ROLE mentorship_admin NOINHERIT NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mentorship_app') THEN
    CREATE ROLE mentorship_app NOINHERIT NOLOGIN;
  END IF;
END $$;
