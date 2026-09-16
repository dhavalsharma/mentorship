import { overlapHoursPerFortnight } from "./availability.js";
import { remainingCapacity } from "./policy.js";
import type { ScoringContext } from "./features.js";
import type { MenteeProfile, MentorProfile } from "./types.js";

/**
 * Hard constraints. The difference between these and a feature with a large
 * negative weight is that a constraint cannot be outvoted — no combination of
 * a wonderful skill fit and a glowing rationale gets a mentee paired with
 * their own manager.
 *
 * A violated constraint produces a *reason string*, which is stored on the
 * candidate row. "Why not her?" is answered with "same manager", not with a
 * shrug about scores.
 */

export interface ConstraintInput {
  mentee: MenteeProfile;
  mentor: MentorProfile;
  ctx: ScoringContext;
}

export interface HardConstraint {
  name: string;
  /** The reason this pair is impossible, or null when it is allowed. */
  violated(input: ConstraintInput): string | null;
}

export const selfPairing: HardConstraint = {
  name: "self",
  violated: ({ mentee, mentor }) =>
    mentee.participantId === mentor.participantId
      ? "a participant cannot mentor themselves"
      : null,
};

export const mentorCapacity: HardConstraint = {
  name: "mentor_capacity",
  violated: ({ mentor }) =>
    remainingCapacity(mentor) <= 0
      ? `mentor is at capacity (${mentor.currentLoad}/${mentor.capacity})`
      : null,
};

export const explicitOptOut: HardConstraint = {
  name: "explicit_opt_out",
  violated: ({ mentee, mentor }) => {
    if (mentee.optOutParticipantIds.includes(mentor.participantId)) {
      return "mentee opted out of this mentor";
    }
    if (mentor.optOutParticipantIds.includes(mentee.participantId)) {
      return "mentor opted out of this mentee";
    }
    return null;
  },
};

/**
 * Same-manager exclusion, and the sharper case of the mentor *being* the
 * mentee's manager. Mentoring inside a reporting line is a performance
 * conversation wearing a different hat, and the mentee cannot speak freely in
 * it. Configurable because small orgs sometimes have no alternative.
 */
export const sameManager: HardConstraint = {
  name: "same_manager",
  violated: ({ mentee, mentor, ctx }) => {
    if (!ctx.policy.excludeSameManager) return null;
    if (mentor.participantId === mentee.managerRef) return "mentor is the mentee's manager";
    if (mentee.participantId === mentor.managerRef) return "mentee is the mentor's manager";
    if (mentee.managerRef && mentor.managerRef && mentee.managerRef === mentor.managerRef) {
      return "same manager";
    }
    return null;
  },
};

export const priorPairing: HardConstraint = {
  name: "prior_pairing",
  violated: ({ mentee, mentor, ctx }) =>
    !ctx.policy.allowRepeatPairing && mentee.priorMentorIds.includes(mentor.participantId)
      ? "already paired in a previous cohort"
      : null,
};

/**
 * Timezone overlap as a constraint rather than a score, because below the
 * threshold the pair is not a worse match — it is an impossible one. Compare
 * `proposeSlots` returning `[]` rather than offering 03:00: saying "no" beats
 * proposing something nobody will attend.
 */
export const timezoneOverlap: HardConstraint = {
  name: "timezone_overlap",
  violated: ({ mentee, mentor, ctx }) => {
    const minimum = ctx.policy.minOverlapHoursPerFortnight;
    if (minimum <= 0) return null;
    const hours = overlapHoursPerFortnight(
      mentee.availability,
      mentor.availability,
      ctx.horizonDays,
    );
    return hours < minimum
      ? `only ${hours.toFixed(1)}h mutual availability per fortnight (need ${minimum}h)`
      : null;
  },
};

export const DEFAULT_HARD_CONSTRAINTS: readonly HardConstraint[] = [
  selfPairing,
  mentorCapacity,
  explicitOptOut,
  sameManager,
  priorPairing,
  timezoneOverlap,
];

export interface ConstraintOutcome {
  eligible: boolean;
  /** Constraint names that rejected the pair, in declaration order. */
  violatedBy: string[];
  /** The human-readable reasons, aligned with `violatedBy`. */
  reasons: string[];
}

/**
 * Every constraint is evaluated, not just the first that fails. An admin
 * relaxing one rule needs to know whether the pair then becomes possible, and
 * short-circuiting hides the second reason until the next run.
 */
export function checkConstraints(
  input: ConstraintInput,
  constraints: readonly HardConstraint[] = DEFAULT_HARD_CONSTRAINTS,
): ConstraintOutcome {
  const violatedBy: string[] = [];
  const reasons: string[] = [];
  for (const constraint of constraints) {
    const reason = constraint.violated(input);
    if (reason !== null) {
      violatedBy.push(constraint.name);
      reasons.push(reason);
    }
  }
  return { eligible: violatedBy.length === 0, violatedBy, reasons };
}
