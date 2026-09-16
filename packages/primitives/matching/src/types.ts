import { z } from "zod";
import { EvidenceSpanSchema, ProgramPolicySchema } from "@mentorship/core";
import type { Interval } from "@mentorship/core";
import type { MatchingPolicy } from "./policy.js";

/**
 * The data matching runs on. Everything here is a zod schema first so the
 * boundary between "what the reader handed us" and "what the pipeline assumes"
 * is checked once, loudly, rather than discovered as a NaN in a score.
 */

/**
 * Availability is a UTC instant, never a wall-clock string (invariant 21).
 * Enforced at the boundary rather than trusted: "Tuesday 3pm" and
 * "2026-03-02T15:00" both parse as *something* in JS, and the resulting
 * overlap errors look like matching bugs for months. A trailing Z or an
 * explicit offset is the cheapest proof the caller meant an instant.
 */
export const UtcInstantSchema = z
  .string()
  .refine(
    (s) => !Number.isNaN(Date.parse(s)) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(s),
    "must be a UTC instant with an explicit offset, not a wall-clock string",
  );

/** Shape-compatible with core's `Interval`, which is an interface, not a schema. */
export const IntervalSchema = z
  .object({ start: UtcInstantSchema, end: UtcInstantSchema })
  .refine((i) => Date.parse(i.end) > Date.parse(i.start), "end must follow start");

export const SkillSchema = z.object({
  name: z.string().min(1),
  /** 1 novice … 5 expert. Coarse on purpose: nobody self-rates to a decimal. */
  level: z.number().int().min(1).max(5),
});
export type Skill = z.infer<typeof SkillSchema>;

/**
 * What a mentee wants to get better at — deliberately a different shape from
 * `Skill`. A goal carries the mentee's *current* level, which is what makes
 * skill fit directional: the question is whether the mentor is ahead on this
 * skill, not whether they both list it.
 */
export const GoalSkillSchema = z.object({
  name: z.string().min(1),
  currentLevel: z.number().int().min(1).max(5).default(1),
  /** Relative importance to the mentee; weights the directional fit. */
  priority: z.number().min(0).max(1).default(1),
});
export type GoalSkill = z.infer<typeof GoalSkillSchema>;

const ProfileBase = {
  participantId: z.string().min(1),
  displayName: z.string().min(1),
  /** Seniority ladder position. 1..12 covers intern → exec in most ladders. */
  level: z.number().int().min(1).max(12),
  tzOffsetMinutes: z.number().int().min(-720).max(840),
  availability: z.array(IntervalSchema).default([]),
  /** Used by the same-manager exclusion. Null when the org chart is unknown. */
  managerRef: z.string().nullable().default(null),
  orgUnit: z.string().nullable().default(null),
  /** Explicit "not this person". Honoured absolutely — it is a hard constraint. */
  optOutParticipantIds: z.array(z.string()).default([]),
  preferredParticipantIds: z.array(z.string()).default([]),
  /** Free-form program flags ("first_time_mentor", "cohort_priority"). */
  fairnessFlags: z.array(z.string()).default([]),
  /**
   * Prose the participant wrote about themselves. UNTRUSTED (invariant 15):
   * it reaches the model as quoted data and never as instruction, and it never
   * authorises anything.
   */
  narrative: z.string().default(""),
};

export const MentorProfileSchema = z.object({
  ...ProfileBase,
  strengths: z.array(SkillSchema).default([]),
  /** How many mentees this mentor is willing to hold in total. */
  capacity: z.number().int().min(0),
  /** How many they already hold. Remaining capacity is what the solver spends. */
  currentLoad: z.number().int().min(0).default(0),
});
export type MentorProfile = z.infer<typeof MentorProfileSchema>;

export const MenteeProfileSchema = z.object({
  ...ProfileBase,
  goals: z.array(GoalSkillSchema).default([]),
  /** Mentors this mentee has already had. Re-pairing is off by default. */
  priorMentorIds: z.array(z.string()).default([]),
});
export type MenteeProfile = z.infer<typeof MenteeProfileSchema>;

/**
 * Risk flags are a closed set. An open string field invites the model to
 * invent a flag that sounds routable — and invariant 16 is explicit that a
 * `safeguarding` flag must not exist until the out-of-band routing does. A
 * flag the model cannot name is a flag nobody can accidentally act on.
 */
export const MatchRiskFlagSchema = z.enum([
  "level_mismatch",
  "timezone_strain",
  "overloaded_mentor",
  "goal_mismatch",
  "thin_profile",
  "prior_relationship",
]);
export type MatchRiskFlag = z.infer<typeof MatchRiskFlagSchema>;

/**
 * One (mentee, mentor) pair as considered. Persisted for every pair the
 * pipeline looked at, winners and losers alike: "why did I get this mentor
 * and not that one?" is the first question an appeal asks, and the answer has
 * to be a row, not a rerun.
 */
export const CandidateRecordSchema = z.object({
  menteeId: z.string(),
  mentorId: z.string(),
  eligible: z.boolean(),
  /** Hard-constraint names that rejected this pair. Empty when eligible. */
  violations: z.array(z.string()),
  /** The full feature vector, including features carrying zero weight. */
  features: z.record(z.number()),
  /** One human-readable line per feature, so a score can be read aloud. */
  explanations: z.record(z.string()),
  /** The number the deterministic pipeline produced. The model never writes this. */
  deterministicScore: z.number().min(0).max(1),
  /** Bounded nudge from adjudication, already clamped to policy. */
  adjustment: z.number(),
  /** deterministicScore + adjustment, clamped to [0,1]. What the solver spends. */
  adjustedScore: z.number().min(0).max(1),
  /** Rank among this mentee's eligible candidates, 1 = best. */
  rank: z.number().int().min(0),
  shortlisted: z.boolean(),
  rationale: z.string().nullable(),
  riskFlags: z.array(MatchRiskFlagSchema),
  /** Spans into the adjudication source, verified to actually quote it. */
  evidence: z.array(EvidenceSpanSchema),
});
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

export const MatchAssignmentSchema = z.object({
  menteeId: z.string(),
  mentorId: z.string(),
  score: z.number().min(0).max(1),
  deterministicScore: z.number().min(0).max(1),
  rank: z.number().int().min(1),
  rationale: z.string().nullable(),
  riskFlags: z.array(MatchRiskFlagSchema),
});
export type MatchAssignment = z.infer<typeof MatchAssignmentSchema>;

export const UnmatchedSchema = z.object({
  menteeId: z.string(),
  reason: z.enum(["no_eligible_mentor", "capacity_exhausted"]),
  /** Which constraints did the rejecting, tallied. Tells an admin what to relax. */
  blockedBy: z.record(z.number()),
});

export const MentorLoadSchema = z.object({
  mentorId: z.string(),
  /** Assigned by this run. */
  assigned: z.number().int().min(0),
  priorLoad: z.number().int().min(0),
  capacity: z.number().int().min(0),
});

export const MatchingOutputSchema = z.object({
  cohortId: z.string(),
  orgId: z.string(),
  asOf: z.string(),
  solver: z.string(),
  /** False when the run never reached the model — the fallback path. */
  adjudicated: z.boolean(),
  /** Mentees whose adjudication call failed and fell back to deterministic. */
  adjudicationErrors: z.number().int().min(0),
  assignments: z.array(MatchAssignmentSchema),
  unmatched: z.array(UnmatchedSchema),
  mentorLoad: z.array(MentorLoadSchema),
  candidates: z.array(CandidateRecordSchema),
});
export type MatchingOutput = z.infer<typeof MatchingOutputSchema>;

export const MatchingPoolSchema = z.object({
  cohortId: z.string().min(1),
  orgId: z.string().min(1),
  mentors: z.array(MentorProfileSchema),
  mentees: z.array(MenteeProfileSchema),
  /** The UTC window the availability intervals describe. */
  horizon: IntervalSchema,
  policy: ProgramPolicySchema,
  /**
   * Per-cohort weight and threshold overrides. See `readMatchingPolicy` for
   * why this is not simply a block inside `ProgramPolicySchema` yet.
   */
  matching: z.unknown().optional(),
});
export type MatchingPool = z.infer<typeof MatchingPoolSchema>;
/**
 * What a reader may hand over: defaulted fields omitted. `resolve` parses it
 * into the complete `MatchingPool`, so a caller assembling a pool from sparse
 * profile rows does not have to spell out six empty arrays per person.
 */
export type MatchingPoolInput = z.input<typeof MatchingPoolSchema>;

export interface MatchingTrigger {
  cohortId: string;
  /**
   * When the run is "as of". Optional, and it defaults to the start of the
   * availability horizon rather than `Date.now()` — a primitive whose resolved
   * context contains a wall clock hashes differently on every call, which
   * destroys both the `ai_runs` input hash and any hope of a golden test.
   */
  asOf?: string;
}

export interface MatchingReader {
  matchingPool(input: { cohortId: string }): Promise<MatchingPoolInput>;
}

/** Resolved, deterministic, model-free. Everything `infer` and `fallback` need. */
export interface MatchingContext {
  cohortId: string;
  orgId: string;
  asOf: string;
  horizon: Interval;
  horizonDays: number;
  mentors: MentorProfile[];
  mentees: MenteeProfile[];
  policy: MatchingPolicy;
}
