-- ADR-0009 backfill. A `SessionLifecycle` entering `cooling` now waits on
-- `pair.preferences_updated` for its own pairing, so a pair that changes its
-- rhythm between sessions is re-timed at once. Instances that were already
-- in `cooling` before that change were saved with no `awaiting_event`, and
-- the engine only delivers an event to an instance whose pattern names it —
-- without this, those pairs would save a new rhythm, see "Saved", and keep
-- sleeping on the old timer for a whole cycle.
--
-- Deliberately untouched: `version` (a worker that read the row before this
-- ran will still save cleanly; if it overwrites the pattern it is because it
-- moved the saga out of `cooling`, where the pattern no longer applies) and
-- `updated_at` (the stuck-saga view reads it as "last advanced", and nothing
-- advanced here). Setting the pattern for a program with pair preferences
-- turned off is harmless: nothing will ever emit the event it waits for.
--
-- Idempotent — only rows with no pattern yet are touched.
UPDATE "saga_instances"
SET "awaiting_event" = jsonb_build_object(
  'names', jsonb_build_array('pair.preferences_updated'),
  'subjectRef', "subject_ref"
)
WHERE "saga_name" = 'SessionLifecycle'
  AND "status" = 'running'
  AND "state" ->> 'name' = 'cooling'
  AND "awaiting_event" IS NULL
  AND "subject_ref" LIKE 'pairing:%';
