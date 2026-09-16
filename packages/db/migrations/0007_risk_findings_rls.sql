-- risk_findings (0006) landed after 0002/0004 already ran, so it needs its
-- own follow-up rather than an edit to migrations that may already be
-- applied elsewhere. Same two policies every tenant table gets: RLS keyed on
-- app.current_org for mentorship_app, and a permissive OR'd policy for
-- mentorship_admin (the outbox relay's role) that is visible and revocable
-- rather than a blanket BYPASSRLS.

ALTER TABLE risk_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_findings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON risk_findings;
CREATE POLICY tenant_isolation ON risk_findings
  USING (org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);

ALTER TABLE risk_findings ALTER COLUMN org_id SET NOT NULL;

DROP POLICY IF EXISTS admin_all_tenants ON risk_findings;
CREATE POLICY admin_all_tenants ON risk_findings
  TO mentorship_admin USING (true) WITH CHECK (true);
