-- Invariant 6: every saga effect is idempotent by key, and that includes the
-- events an effect emits — `emit` itself, and the runner's own emits inside
-- an effect (`session.scheduled` after `createEvent`, `document.rendered`
-- after a render, ...). The engine's completed-effect ledger is saved only
-- when the whole step saves, so a crash after an event committed and before
-- the step saved re-ran the effect and appended the event a second time.
--
-- The effect runner now stamps each such event with its effect key (plus the
-- event name) and `PostgresEventSink` inserts with ON CONFLICT DO NOTHING
-- against this index, returning the row that was already there. Enforced here
-- rather than by a SELECT-then-INSERT for the same reason as 0011: READ
-- COMMITTED lets two writers both pass the SELECT.
--
-- Partial, because events that do not come from a saga effect (a Slack click,
-- a digest, a roster import) carry no key and must stay free to repeat. Scoped
-- by org because a key is only meaningful within one tenant's sagas. No RLS
-- change: `events` already has its tenant policy (0002), and the table-level
-- grants (0003) cover a new column.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_idempotency_key_unique" ON "events" USING btree ("org_id","idempotency_key") WHERE "events"."idempotency_key" IS NOT NULL;
