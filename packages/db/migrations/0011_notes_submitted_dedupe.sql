-- Slack's Events API redelivers a message it did not hear a 200 for within
-- three seconds, carrying the same `ts`. `PostgresNotesSink.submit` used to
-- guard against that with a SELECT-then-INSERT, which under READ COMMITTED is
-- a TOCTOU race: the retry and the original can both pass the SELECT before
-- either commits, and the pair gets two `notes.submitted` events for one
-- message — which is then extracted as if the participant said it twice.
--
-- Every other redelivery guard in this schema is a unique index rather than an
-- application check (`nudges_dedupe_unique`, `feedback_unique`,
-- `consents_unique`, `identity_links_unique`); this one now is too, and the
-- insert is an ON CONFLICT DO NOTHING.
--
-- Partial, on `name`, because `events` is the shared append-only log: only
-- `notes.submitted` carries a `noteId`, and every other event name must stay
-- free to repeat. The expression member is `payload->>'noteId'` rather than a
-- column, because the payload shape belongs to the event and not to the table.

CREATE UNIQUE INDEX IF NOT EXISTS "events_note_submitted_unique"
  ON "events" USING btree ("org_id", "subject_ref", ("payload" ->> 'noteId'))
  WHERE "name" = 'notes.submitted';
