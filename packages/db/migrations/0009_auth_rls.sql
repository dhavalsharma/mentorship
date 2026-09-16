-- magic_links and auth_sessions (0008) landed after 0002/0004 already ran, so
-- they need their own follow-up rather than an edit to migrations that may
-- already be applied elsewhere. Same two policies every tenant table gets:
-- RLS keyed on app.current_org for mentorship_app, and a permissive OR'd
-- policy for mentorship_admin (the outbox relay's role) that is visible and
-- revocable rather than a blanket BYPASSRLS.

ALTER TABLE magic_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON magic_links;
CREATE POLICY tenant_isolation ON magic_links
  USING (org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);

ALTER TABLE magic_links ALTER COLUMN org_id SET NOT NULL;

DROP POLICY IF EXISTS admin_all_tenants ON magic_links;
CREATE POLICY admin_all_tenants ON magic_links
  TO mentorship_admin USING (true) WITH CHECK (true);

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON auth_sessions;
CREATE POLICY tenant_isolation ON auth_sessions
  USING (org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);

ALTER TABLE auth_sessions ALTER COLUMN org_id SET NOT NULL;

DROP POLICY IF EXISTS admin_all_tenants ON auth_sessions;
CREATE POLICY admin_all_tenants ON auth_sessions
  TO mentorship_admin USING (true) WITH CHECK (true);
