-- `withoutTenantIsolation` does `set local role mentorship_admin` and expects to
-- see across tenants. Without this it would see *nothing*: 0002 FORCEs RLS, so
-- the table owner is not exempt either, and with `app.current_org` unset the
-- tenant_isolation predicate evaluates to NULL — which filters everything out
-- rather than letting everything through. A relay that silently reads zero rows
-- is the worst failure mode available, because it looks like an idle queue.
--
-- Permissive policies OR together, so this grants mentorship_admin full access
-- while tenant_isolation continues to govern every other role. Preferred over
-- `ALTER ROLE mentorship_admin BYPASSRLS` because it is visible in the schema,
-- revocable per table, and does not need a superuser at deploy time.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'programs', 'cohorts', 'users', 'identity_links', 'participants',
    'profile_attributes', 'pairings', 'match_candidates', 'agreements',
    'sessions', 'session_notes', 'extractions', 'action_items', 'goals',
    'goal_checkins', 'signals', 'nudges', 'events', 'ai_runs',
    'saga_instances', 'integration_bindings', 'consents', 'audit_log',
    'roster_imports', 'feedback', 'organizations'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_all_tenants ON %I', t);
    EXECUTE format(
      'CREATE POLICY admin_all_tenants ON %I TO mentorship_admin USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;

-- Migration bookkeeping is infrastructure, not application data.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE schema_migrations FROM mentorship_app;
  END IF;
END $$;
