-- Invariant 6, the half the key alone could not cover. An effect key is
-- `{instance}:{stepIndex}:{index}` — safe only if one `stepIndex` only ever
-- means one effect list. A retried step used to call `step()` again and match
-- its *new* effects against the ledger by index: a retry could mint a second
-- agreement id and skip the effects that posted buttons for the first, and a
-- different input arriving at a failed step's `stepIndex` ran its effects
-- under keys the failed step's partial ledger already held, so they were
-- skipped as "done" (PR #13 review findings 1 and 2).
--
-- The engine now writes the decided step here — input identity, effects,
-- next state, wait and timeout — *before* the first effect runs, and clears
-- it when the step commits. Any retry (a thrown effect, a killed process, a
-- redelivered event) replays this exact list; any other input finishes it
-- first. NULL means no step is in flight, which is every row that existed
-- before this column did, so there is nothing to backfill.
--
-- No RLS or grant change: `saga_instances` already has its tenant policy
-- (0002), and the table-level grants (0003) cover a new column.

ALTER TABLE "saga_instances" ADD COLUMN IF NOT EXISTS "pending_step" jsonb;
