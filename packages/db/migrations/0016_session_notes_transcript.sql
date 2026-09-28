-- e2e bug #9. `fetch_transcript` used to keep the transcript text in the
-- effect runner's memory until the next pass extracted from it, so a worker
-- restarted in between extracted from an empty string. The text is now
-- written to `session_notes` (kind 'transcript') before `transcript.available`
-- is announced, and read back by `run_extraction` through
-- `PostgresSessionSourceStore` — the table's documented purpose, never used
-- until now.
--
-- This index is what makes that write idempotent (invariant 6): a fetch
-- retried after a crash re-fetches the same (session, vendor ref) and lands
-- here with ON CONFLICT DO NOTHING. Partial on kind: typed notes carry no
-- vendor ref and must stay free to repeat.
--
-- No RLS or grant change: `session_notes` has had its tenant policy since
-- 0002 and its table grants since 0003.

CREATE UNIQUE INDEX IF NOT EXISTS "session_notes_transcript_ref_unique" ON "session_notes" USING btree ("org_id","session_id","external_ref") WHERE "session_notes"."kind" = 'transcript';
