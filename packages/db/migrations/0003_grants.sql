-- Grants, after the tables exist and RLS is on.
--
-- mentorship_app gets DML and nothing else: no DDL, no ownership, and crucially
-- no BYPASSRLS, which is the whole point — a policy that the application role
-- can step around is decoration. mentorship_admin is for migrations and the
-- outbox relay, which legitimately cross tenants (see `withoutTenantIsolation`).

GRANT USAGE ON SCHEMA public TO mentorship_app, mentorship_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO mentorship_app, mentorship_admin;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO mentorship_app, mentorship_admin;

-- Tables added by a later migration should not need a grant migration of their
-- own. The default applies to objects created by the role that runs migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mentorship_app, mentorship_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mentorship_app, mentorship_admin;

-- The relay and migrations run as mentorship_admin, which means whoever
-- connects has to be able to SET ROLE into it. Both roles are NOINHERIT, so
-- membership grants the ability to switch without silently inheriting rights.
GRANT mentorship_admin TO mentorship_app;

-- mentorship_admin still sits under RLS on FORCE'd tables; it is a convenience
-- boundary and an audit marker, not a bypass. Anything that genuinely must read
-- across tenants (the outbox relay) needs BYPASSRLS granted by an operator who
-- has decided that deliberately:
--
--   ALTER ROLE mentorship_admin BYPASSRLS;
