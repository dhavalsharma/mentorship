-- Vendor-specific settings for a bound adapter: the Drive folder id and
-- guideline doc id for `slot = 'document'`, and whatever the equivalent is
-- for the next backend someone binds there.
--
-- A generic jsonb column rather than typed columns per vendor: the whole
-- point of the slot/adapter split is that `packages/core` never learns what a
-- folder id is, and a `drive_folder_id` column here would push that knowledge
-- into the schema — the one place CLAUDE.md's opening argument says program
-- and vendor specifics must never be compiled. The adapter owns the shape and
-- parses it with its own Zod schema.
--
-- NOT NULL with a default so every existing row reads as "no config" rather
-- than null-vs-empty ambiguity at every call site.

ALTER TABLE integration_bindings
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- RLS on this table was established in 0002 and is unchanged by adding a
-- column; the existing tenant_isolation / admin_all_tenants policies cover it.
