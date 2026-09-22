import { z } from "zod";
import type { ProgramPolicy } from "@mentorship/core";

/**
 * Matching policy is DATA (ADR-0001). Every number that changes who gets
 * matched with whom lives here and arrives at runtime — no code path branches
 * on a tenant, and no weight is a constant in a scorer.
 */

/**
 * Defaults, not law. They are here so a program that says nothing still gets a
 * defensible match; a program that has run a cohort and fitted its own weights
 * overrides every one of them.
 *
 * Skill fit and availability carry the most weight because they are the two
 * things a participant will name when the match is wrong: "they can't help me
 * with what I asked for" and "we could never find a time".
 */
export const DEFAULT_MATCHING_WEIGHTS: Record<string, number> = {
  skill_fit_directional: 0.35,
  availability_overlap: 0.25,
  level_gap_band: 0.2,
  stated_preference: 0.1,
  program_fairness: 0.1,
};

export const MatchingPolicySchema = z.object({
  /**
   * Keyed by `FeatureScorer.name`. A scorer with no entry still runs and still
   * records its feature — it just contributes nothing to the score. That is
   * how you measure a candidate feature before you trust it with weight.
   */
  weights: z.record(z.number().min(0)).default(DEFAULT_MATCHING_WEIGHTS),

  /** Below this, the pair cannot realistically meet: a hard constraint, not a penalty. */
  minOverlapHoursPerFortnight: z.number().min(0).default(1),
  /** Overlap at or above this scores 1.0. More than enough is not better. */
  targetOverlapHoursPerFortnight: z.number().positive().default(4),

  levelGap: z
    .object({
      /** A mentor one to two levels up is the band that actually works. */
      idealMin: z.number().int().default(1),
      idealMax: z.number().int().default(2),
      /**
       * Applied to distance from the band in both directions, because too
       * senior is as bad as too junior: a peer has nothing to teach, and an
       * exec five levels up has no shared context and no time.
       */
      decayPerLevel: z.number().min(0).max(1).default(0.3),
      floor: z.number().min(0).max(1).default(0.02),
    })
    .default({}),

  allowRepeatPairing: z.boolean().default(false),
  excludeSameManager: z.boolean().default(true),

  /** How many candidates per mentee the model is allowed to look at. */
  shortlistSize: z.number().int().min(1).max(25).default(8),
  /**
   * The hard ceiling on the model's influence (invariant 17). The model may
   * move a score by at most this much in either direction; it can reorder a
   * shortlist at the margin and it can never manufacture a winner.
   */
  maxAdjustment: z.number().min(0).max(0.25).default(0.05),
  /**
   * Cost added to a mentor's k-th assignment, k = 0,1,2… A convex penalty, so
   * the solver spreads mentees across mentors when scores are close but still
   * doubles up a mentor when the alternative is materially worse.
   */
  loadBalancePenalty: z.number().min(0).max(1).default(0.02),
  /** Boost per fairness flag, keyed by flag name. Empty means fairness is load-only. */
  fairnessFlagWeights: z.record(z.number()).default({}),
});

export type MatchingPolicy = z.infer<typeof MatchingPolicySchema>;

export function defaultMatchingPolicy(
  overrides: Partial<z.input<typeof MatchingPolicySchema>> = {},
): MatchingPolicy {
  return MatchingPolicySchema.parse(overrides);
}

/**
 * Pull the matching block out of a program policy.
 *
 * `ProgramPolicySchema.matching` (added while building the preset policies,
 * ADR-0001 action item 4) is a deliberately untyped `z.record(z.unknown())`
 * bag — core cannot import `MatchingPolicySchema` without inverting the
 * `primitives -> core` dependency direction, so it round-trips the block
 * without validating its shape. This function remains the single place that
 * actually parses it into a `MatchingPolicy`, and an `override` still wins
 * over whatever the stored program policy carries.
 */
export function readMatchingPolicy(
  programPolicy: ProgramPolicy,
  override?: unknown,
): MatchingPolicy {
  const fromProgram = (programPolicy as { matching?: unknown }).matching;
  const raw = (override ?? fromProgram ?? {}) as Record<string, unknown>;
  const parsed = MatchingPolicySchema.parse(raw);
  // Weights merge rather than replace: a program that wants to re-weight one
  // feature should not have to restate the other four, and silently zeroing a
  // feature by omission is exactly the bug nobody notices.
  return {
    ...parsed,
    weights: { ...DEFAULT_MATCHING_WEIGHTS, ...(raw.weights as Record<string, number> | undefined) },
  };
}

/** Remaining capacity, falling back to the program default when unset. */
export function remainingCapacity(
  mentor: { capacity: number; currentLoad: number },
): number {
  return Math.max(0, mentor.capacity - mentor.currentLoad);
}
