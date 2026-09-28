import { createHash } from "node:crypto";
import type { IdFactory } from "@mentorship/core";

/**
 * `sequentialIds`, shaped for Postgres: every id column is `uuid`, and ids
 * must stay unique across every org sharing the database, so `agr_001` is not
 * an option. A hash of (seed, counter) gives both — a stage's ids are a pure
 * function of its org id and how many it has asked for, so two identical runs
 * mint ids in the same order, and the determinism property compares them
 * after mapping each run's ids to their order of first appearance.
 *
 * The factory lives on the stage, not the worker: a restarted worker keeps
 * drawing from the same sequence, the way a real process restart keeps
 * drawing from a random source that never repeats. A counter reset on restart
 * would re-mint an agreement id already on record — and the projector's
 * `ON CONFLICT DO NOTHING` would swallow that silently.
 */
export function seededUuids(seed: string): IdFactory {
  let n = 0;
  return {
    next() {
      n += 1;
      const h = createHash("sha256").update(`${seed}:${n}`).digest("hex");
      // Version and variant nibbles set so it is a well-formed v4 shape.
      return [
        h.slice(0, 8),
        h.slice(8, 12),
        `4${h.slice(13, 16)}`,
        `${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`,
        h.slice(20, 32),
      ].join("-");
    },
  };
}
