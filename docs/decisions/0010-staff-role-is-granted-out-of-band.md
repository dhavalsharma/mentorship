# ADR-0010: A staff role is a column on `users`, granted out of band

**Status:** Accepted
**Date:** 2026-09-29
**Deciders:** dhaval (WeKan.AI)

## Context

`apps/api`'s admin routes — the four monitoring lists, matching-round
candidates, cohort invites and the two integration-settings screens — asked
one question of a caller: is this a valid, unexpired session for this org?
Every handler then built its `Actor` with a hardcoded `role: "admin"`, with a
comment explaining that a session was "the only role apps/api knows how to
establish".

That was a latent hole while the only people with sessions were the few who
knew to request a magic link. Cohort invites turned it into a real one: an
invite now *issues* each invitee a magic link, and following it signs them
in. Every invited mentee therefore got the admin dashboard, every
organisation's risk findings, and the invite route itself — so they could
invite others, who could invite others.

A magic link proves control of an email address. It says nothing about
whether that person runs the program. The system needed somewhere to record
the second fact, and a gate that reads it on every staff route.

`packages/core`'s `authorize()` already had the right vocabulary: `admin` and
`program_lead` are org-chart roles, `mentor`/`mentee`/`participant` are pair
roles, and resources such as `enrolment.invite` already refused pair roles.
What was missing was any way for a session to resolve to one of them.

## Decision

- **`users.staff_role`**, nullable text, `CHECK (staff_role IN ('admin',
  'program_lead'))` (migration `0017_users_staff_role.sql`). NULL means not
  staff. Core exports `StaffRoleSchema` — the org-chart half of
  `ActorRoleSchema` — and `ORG_CHART_ROLES` is built from it.
- **A `StaffDirectory` port** in `packages/auth`
  (`staffRoleOf(orgId, userId)`), with `PostgresStaffDirectory` reading the
  column inside `withTenant`. It is a **required** field of `apps/api`'s
  `AuthDeps`, so wiring sign-in without it is a compile error.
- **`authenticateStaff`** replaces `authenticateAdmin`: no session → 401;
  another org → 403; a valid session whose user has no staff role → 403 with
  the identical `{ error: "forbidden" }` body. Every staff route then calls
  `authorize()` with the *resolved* role. The role is read on every request,
  never cached on the session, so revoking it takes effect immediately.
- **`integration.settings`** is a new resource type, admin-only. A program
  lead keeps everything the matrix already gave org-chart roles (the lists,
  the candidates, `enrolment.invite`) but cannot repoint the tenant's Drive
  folder or report spreadsheet.
- **Granted out of band**: `pnpm staff:grant --email … --role
  admin|program_lead|none`, with `DATABASE_URL` and `ORG_ID`. It creates the
  user if needed (never overwriting an existing name or zone), sets or clears
  the role, and writes a `staff.role_changed` audit row with the old and new
  role, in one `withTenant` transaction.
- **No backfill.** After the migration nobody is staff until someone runs
  `pnpm staff:grant`.
- `apps/web` sends a signed-in non-staff user to `/no-access` rather than back
  to `/login`, which would only loop them through another link to the same
  refusal.

## Options Considered

### Option A: A nullable role column on `users` (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — one column, one CHECK, one port |
| Cost | One indexed-by-primary-key read per staff request |
| Correctness | High — per-tenant data, under RLS, audited |
| Team familiarity | High |

**Pros:** `users` is already org-scoped and unique on org + email, so "is
this person staff *here*" is exactly one row's attribute. It inherits the
existing RLS policy and grants, so there is no new tenancy surface. The CHECK
means a hand-typed `UPDATE` cannot mint a role `authorize()` has never heard
of.

**Cons:** One role per person per org. If a tenant ever needs someone to be
both, or needs roles scoped below the org (lead of one program only), this
becomes a table.

### Option B: A separate `staff_roles` table

**Pros:** Several roles per user; room for a scope column (program, cohort)
later.

**Cons:** Solves a problem nothing has. Users are already per-org, and no
current resource distinguishes a lead of program X from a lead of program Y.
A join table would add a second RLS policy, a second grant, and a question
("which of this user's roles wins?") that `authorize()` would then have to
answer. Migrating from a column to a table when a real need appears is a
small, mechanical change; the reverse is not needed.

### Option C: Derive staff from `participants.role`

**Pros:** No schema change. A program's policy already names roles.

**Cons:** This is the confusion that caused the hole. `participants.role` is
cohort-scoped and a *pair* role — someone's place in a pairing — and program
policy may call its roles anything (ADR-0001). Reading "mentor" as "may see
every pair's risk findings" would make the admin surface depend on what a
program chose to call its participants, and would still leave the tenant's
actual operators — who are usually in no cohort at all — with no role.

### Option D: An environment-variable allowlist of admin emails

**Pros:** Trivial; no migration.

**Cons:** Not per-tenant data: one process's env would name the admins of
whatever org it happens to be bound to, and a mistake is invisible until
someone is locked out or let in. Changing it means a redeploy. Nothing is
audited — there is no record of who was made an admin or when. It is also a
second source of truth beside the database that RLS protects.

### Option E: Backfill every existing user as `admin`

**Pros:** Nobody who signs in today loses access after the migration.

**Cons:** It recreates the hole on day one. Existing users include every
roster-imported and invited participant; making them admin is exactly the
state being fixed. The migration cannot know who a tenant's real admins are,
so it does not guess.

## Trade-off Analysis

The choice is between the smallest schema that records the fact (A) and
shapes that anticipate needs nobody has stated (B), or that avoid a schema
change by reading the wrong fact (C, D). A is the only one that is per-tenant,
under RLS, audited, and not confusable with a pair role.

The cost of refusing E is operational: every tenant must run
`pnpm staff:grant` once before anyone can use the dashboard. That is the
correct cost — someone with the database URL already holds that authority,
and it is written to `audit_log`.

## Consequences

**Easier**
- Adding a staff-only resource: add it to `ResourceTypeSchema`, decide which
  staff roles it admits, call `authorizeStaff` — the role is already resolved.
- Answering "who made this person an admin, and when": `audit_log`,
  `action = 'staff.role_changed'`.
- Revoking access: `--role none`, or "Remove access" on the staff page,
  effective on the next request.

**Harder**
- First-run setup has one more step, and forgetting it looks like "the
  dashboard shows No access" rather than an error. The README and
  `docs/live-tenant-testing.md` say so where someone first signs in.
- A route that reads pair-scoped data (feedback sentiment, a
  participant-attributed signal) still has to resolve pairing membership
  itself; a staff role deliberately grants nothing there (invariant 14).

**Since built: granting and revoking from the dashboard.** Out of band is
now only how a tenant gets its *first* admin. After that an admin uses
`GET`/`PUT /orgs/:orgId/staff` (`apps/web`'s `/dashboard/settings/staff`):
- `staff.roles` is a new resource type, **admin only** — a program lead who
  could grant roles could grant themselves admin, so there is no sense in
  which the resource could be lead-visible but lead-safe.
- The route calls the same `grantStaffRole` as `pnpm staff:grant`. The audit
  row is the same `staff.role_changed`, with `actor_type: "admin"` and the
  acting admin's user id as `actor_ref` (the pair `participant.invited`
  already uses) instead of `operator` / `cli:<os user>`.
- **The last admin cannot be removed from the dashboard** — 409, nothing
  written. Without it, one click (usually an admin demoting themselves) locks
  a tenant out of every admin-only screen until an operator runs the CLI.
  The guard is a count, so it is made race-safe inside the grant's own
  transaction: every admin row of the org is locked `FOR UPDATE` in id order
  before the target is read, so two admins demoting each other queue, and the
  second re-reads a count the first already changed.
- **The actor's own authority is re-checked under that lock** — 403, nothing
  written, if the acting admin is no longer among the locked admin rows.
  `authenticateStaff` read their role in an earlier transaction, and the lock
  makes that gap reliable rather than rare: a request that authenticated
  while another admin's demotion of its actor was still open queues on the
  lock and would otherwise run next with the stale authority. The last-admin
  guard only looks at the target, so a promotion — re-promoting themselves,
  or an accomplice — would have gone straight through, and revoking a
  compromised admin from the dashboard could not be relied on. The guarded
  path requires `actorRef` in its type, since this check is made against it.
- **The CLI is deliberately not guarded.** The operator is the authority the
  guard defers to, and revoking a compromised sole admin is exactly the job
  it is for.
- Revoking an email with no user row is a 404 (and a CLI error) rather than
  creating a user just to record that they are not staff.

**To revisit**
- A table (Option B) if roles ever need a scope below the org.
- No "who changed what" view over `staff.role_changed` in the dashboard yet;
  `audit_log` is the record.

## Action Items

1. [x] `users.staff_role` + CHECK, migration `0017`, no backfill
2. [x] `StaffRoleSchema`; `integration.settings` resource, admin-only
3. [x] `StaffDirectory` port, `PostgresStaffDirectory`, required on `AuthDeps`
4. [x] `authenticateStaff` + `authorize()` with the resolved role on every staff route
5. [x] `pnpm staff:grant`, audited
6. [x] `apps/web` `/no-access`
7. [x] Grant/revoke staff from the UI — `staff.roles` (admin-only),
   `GET`/`PUT /orgs/:orgId/staff`, `/dashboard/settings/staff`, the
   race-safe last-admin guard
