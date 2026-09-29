# Migrations

```bash
docker compose up -d db
pnpm db:migrate
```

Applied in filename order, each in its own transaction, recorded in
`schema_migrations`. The runner is `packages/db/src/migrate.ts` — about sixty
lines, because half of these files are hand-written and teaching drizzle's
journal about files it did not generate costs more than reading a directory.

| File | What it does | Written by |
| --- | --- | --- |
| `0000_roles.sql` | `mentorship_app` and `mentorship_admin`, if absent | hand |
| `0001_init.sql` | Every table and index | `drizzle-kit generate` |
| `0002_rls.sql` | RLS on, forced, tenant policy per table | hand |
| `0003_grants.sql` | DML for the two roles; no DDL, no BYPASSRLS | hand |
| `0004_admin_policy.sql` | The admin role's cross-tenant policy, for the relay | hand |
| `0013_cooling_preferences_wait.sql` | Data backfill: running `SessionLifecycle` instances already in `cooling` start waiting on `pair.preferences_updated` (ADR-0009) | hand |
| `0014_events_idempotency_key.sql` | `events.idempotency_key` + a partial unique index on `(org_id, idempotency_key)`: a saga effect's events dedupe by effect key across a crash-retry (invariant 6) | `drizzle-kit generate`, commented by hand |
| `0015_saga_pending_step.sql` | `saga_instances.pending_step`: the engine's write-ahead record of a decided-but-uncommitted step, so a retry replays the same effects under the same keys instead of re-running `step()` | `drizzle-kit generate`, commented by hand |
| `0016_session_notes_transcript.sql` | Partial unique index on `session_notes (org_id, session_id, external_ref) WHERE kind = 'transcript'`: a fetched transcript is stored once, before `transcript.available`, so a restarted worker extracts from it rather than from memory (e2e bug #9) | `drizzle-kit generate`, commented by hand |
| `0017_users_staff_role.sql` | `users.staff_role` (`admin` \| `program_lead` \| NULL) with a CHECK: the only thing that lets a signed-in session into the admin routes. No backfill — nobody is staff until `pnpm staff:grant` (ADR-0010) | `drizzle-kit generate`, commented by hand |

## Adding a structural migration

`pnpm db:generate` writes a file named after drizzle's journal index, e.g.
`0005_famous_iron_man.sql`. Rename it into the sequence (`0005_add_x.sql`) and
leave the journal alone — the journal's `idx` only decides what the *next*
generated file is called, and it is deliberately set past the hand-written
files so the two numbering schemes cannot collide.

## The role split

`mentorship_app` is what the application connects as: DML only, no ownership,
no `BYPASSRLS`. That last part is the point — a policy the application role can
step around is decoration.

`mentorship_admin` is for migrations and the outbox relay, which legitimately
read across tenants. It gets there through an explicit policy
(`0004_admin_policy.sql`) rather than `BYPASSRLS`, so the exception is visible
in the schema and revocable per table.

Locally both roles are `NOLOGIN` and the connection is the superuser, which
bypasses RLS entirely. That is why anything meaning to prove isolation has to
say so:

```ts
await withTenant(db, orgId, fn, { role: "mentorship_app" });
```

`packages/db/src/__tests__/rls.test.ts` is the executable version of the
verification recipe at the bottom of `0002_rls.sql`. Run it with a database:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/mentorship pnpm test
```
