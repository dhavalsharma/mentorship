-- Row-level security for every tenant-scoped table.
--
-- Run AFTER the drizzle-generated structural migration (0001). Application
-- code connects as `mentorship_app`, which is NOT the table owner and has no
-- BYPASSRLS, so a query that forgets its WHERE clause returns zero rows rather
-- than another organisation's data. `mentorship_admin` exists for migrations
-- and the outbox relay, which legitimately cross tenants.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'programs', 'cohorts', 'users', 'identity_links', 'participants',
    'profile_attributes', 'pairings', 'match_candidates', 'agreements',
    'sessions', 'session_notes', 'extractions', 'action_items', 'goals',
    'goal_checkins', 'signals', 'nudges', 'events', 'ai_runs',
    'saga_instances', 'integration_bindings', 'consents', 'audit_log',
    'roster_imports', 'feedback'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (org_id = current_setting('app.current_org', true)::uuid)
        WITH CHECK (org_id = current_setting('app.current_org', true)::uuid)
    $f$, t);

    -- Belt and braces: a NULL org_id would otherwise be invisible to every
    -- tenant and impossible to clean up.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', t);
  END LOOP;
END $$;

-- The organizations table is the one exception: a tenant may read its own row,
-- and nothing else.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_org ON organizations;
CREATE POLICY own_org ON organizations
  USING (id = current_setting('app.current_org', true)::uuid);

-- Roles. Create these once per database, outside the migration, if your
-- provisioning does not already manage them.
--
--   CREATE ROLE mentorship_admin NOINHERIT LOGIN PASSWORD '...';
--   CREATE ROLE mentorship_app   NOINHERIT LOGIN PASSWORD '...';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mentorship_app;
--   GRANT USAGE ON SCHEMA public TO mentorship_app;
--
-- Verify the policy actually bites before you trust it — this should return 0:
--
--   SET ROLE mentorship_app;
--   SELECT set_config('app.current_org', '<org A uuid>', false);
--   SELECT count(*) FROM pairings WHERE org_id = '<org B uuid>';
