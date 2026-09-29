-- ADR-0010. Until this column existed, `apps/api` treated every valid session
-- as an admin: a magic link proves who someone is, and the admin routes asked
-- nothing more. Once cohort invites started sending magic links, every invited
-- mentee could open the admin dashboard and send invites of their own.
--
-- `staff_role` is the one fact that separates "signed in" from "runs this
-- program": 'admin' or 'program_lead' (core's `StaffRoleSchema`, which mirrors
-- the org-chart half of `ActorRoleSchema`), NULL for everyone else. It lives on
-- `users` rather than in a table of its own because users are already
-- org-scoped (unique on org + email) and nothing needs several staff roles per
-- person. It is deliberately not derived from `participants.role`, which is a
-- cohort-scoped *pair* role — the confusion that caused the hole.
--
-- No backfill, on purpose. This migration cannot know who a tenant's admins
-- are, and marking every existing user 'admin' would recreate exactly the bug
-- it closes. After applying it nobody is staff until an operator runs
-- `pnpm staff:grant --email … --role admin`, which also writes the audit row.
--
-- No RLS or grant change: `users` has had its tenant policy since 0002 (and
-- the admin policy since 0004), and the table-level grants in 0003 cover a
-- new column. The CHECK is the database's own refusal of a bogus role, so a
-- typo in a hand-run UPDATE cannot mint a role `authorize()` has never heard of.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "staff_role" text;
ALTER TABLE "users" ADD CONSTRAINT "users_staff_role_check" CHECK ("users"."staff_role" IS NULL OR "users"."staff_role" IN ('admin', 'program_lead'));
