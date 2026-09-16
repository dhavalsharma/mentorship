import { overlapHoursPerFortnight } from "./availability.js";
import { remainingCapacity } from "./policy.js";
import type { MatchingPolicy } from "./policy.js";
import type { MenteeProfile, MentorProfile } from "./types.js";

/**
 * Feature scorers: small, independent, individually testable functions from a
 * (mentee, mentor) pair to a number in [0,1]. They are registrable because
 * every program eventually wants one of its own — a language match, a campus,
 * a cohort-specific fairness rule — and the alternative to a registry is a
 * fork of the scoring file.
 *
 * Every scorer returns an explanation alongside its number. That is not a
 * nicety: invariant 17 says a number that affects a person must be answerable,
 * and "0.62" is not an answer.
 */

export interface ScoringContext {
  policy: MatchingPolicy;
  horizonDays: number;
}

export interface FeatureScore {
  value: number;
  explain: string;
}

export interface FeatureScorerInput {
  mentee: MenteeProfile;
  mentor: MentorProfile;
  ctx: ScoringContext;
}

export interface FeatureScorer {
  name: string;
  score(input: FeatureScorerInput): FeatureScore;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
/**
 * Four decimal places. Rounding is what makes ranks stable: without it, a
 * two-minute change to one availability block moves the fifteenth decimal and
 * can flip a tie, which reads to an admin as the matcher being random.
 */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

const sameSkill = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Directional skill fit — NOT symmetric overlap.
 *
 * The distinction is the whole feature. Two people who both list "system
 * design" at level 4 have a great symmetric overlap and are peers, not a
 * mentor/mentee pair. What matters is whether the mentor is *ahead* of the
 * mentee on the skill the mentee asked to grow, so credit is a function of the
 * gap and a gap of zero earns nothing.
 */
export const skillFitDirectional: FeatureScorer = {
  name: "skill_fit_directional",
  score({ mentee, mentor }) {
    if (mentee.goals.length === 0) {
      // Unknown, not bad. Scoring a thin profile as a poor match punishes the
      // participant for the onboarding form being long.
      return { value: 0.5, explain: "no stated goals; scored neutral" };
    }
    let credited = 0;
    let total = 0;
    const covered: string[] = [];
    for (const goal of mentee.goals) {
      total += goal.priority;
      const strength = mentor.strengths.find((s) => sameSkill(s.name, goal.name));
      if (!strength) continue;
      const gap = strength.level - goal.currentLevel;
      // A gap of two levels is as much as anyone can usefully transfer in a
      // cohort; beyond that the mentor is explaining from too far away.
      const credit = gap <= 0 ? 0 : Math.min(gap, 2) / 2;
      if (credit > 0) covered.push(`${goal.name} (+${Math.min(gap, 2)})`);
      credited += goal.priority * credit;
    }
    const value = total === 0 ? 0.5 : credited / total;
    return {
      value: clamp01(value),
      explain: covered.length
        ? `mentor is ahead on ${covered.join(", ")}`
        : "mentor is not ahead on any stated goal skill",
    };
  },
};

/**
 * Level gap. Peaks inside the policy band and decays in BOTH directions,
 * because a mentor five levels up is as unhelpful as a peer: no shared
 * context, no calendar, and a conversation that turns into a fan meeting.
 */
export const levelGapBand: FeatureScorer = {
  name: "level_gap_band",
  score({ mentee, mentor, ctx }) {
    const gap = mentor.level - mentee.level;
    const { idealMin, idealMax, decayPerLevel, floor } = ctx.policy.levelGap;
    const distance =
      gap < idealMin ? idealMin - gap : gap > idealMax ? gap - idealMax : 0;
    const value = Math.max(floor, 1 - decayPerLevel * distance);
    const shape =
      distance === 0
        ? "inside the ideal band"
        : gap < idealMin
          ? "too close in seniority"
          : "too senior";
    return { value: clamp01(value), explain: `level gap ${gap >= 0 ? "+" : ""}${gap}, ${shape}` };
  },
};

/** Mutual free hours per fortnight, from UTC interval sets (invariant 21). */
export const availabilityOverlap: FeatureScorer = {
  name: "availability_overlap",
  score({ mentee, mentor, ctx }) {
    const hours = overlapHoursPerFortnight(
      mentee.availability,
      mentor.availability,
      ctx.horizonDays,
    );
    const target = ctx.policy.targetOverlapHoursPerFortnight;
    return {
      value: clamp01(hours / target),
      explain: `${round4(hours)}h mutual per fortnight (target ${target}h)`,
    };
  },
};

/**
 * Stated preferences. A lift, never a gate — neutral sits at 0.5 so that a
 * pair nobody named is not treated as a pair somebody objected to. Objections
 * are a hard constraint; they are not expressed here.
 */
export const statedPreference: FeatureScorer = {
  name: "stated_preference",
  score({ mentee, mentor }) {
    const menteeAsked = mentee.preferredParticipantIds.includes(mentor.participantId);
    const mentorAsked = mentor.preferredParticipantIds.includes(mentee.participantId);
    if (menteeAsked && mentorAsked) return { value: 1, explain: "both parties asked for each other" };
    if (menteeAsked) return { value: 0.8, explain: "mentee asked for this mentor" };
    if (mentorAsked) return { value: 0.8, explain: "mentor asked for this mentee" };
    return { value: 0.5, explain: "no stated preference either way" };
  },
};

/**
 * Program fairness. Two parts: headroom, which keeps a popular mentor from
 * absorbing the cohort before anyone notices, and configured flag boosts, so a
 * program can say "first-time mentors get a first pick" as data.
 *
 * Headroom here is the *soft* version of the same idea the solver enforces
 * with a convex capacity cost. Both are needed: this one shapes the ranking an
 * admin reads, that one shapes the allocation.
 */
export const programFairness: FeatureScorer = {
  name: "program_fairness",
  score({ mentee, mentor, ctx }) {
    const capacity = Math.max(1, mentor.capacity);
    const headroom = clamp01(remainingCapacity(mentor) / capacity);
    const flags = [...mentee.fairnessFlags, ...mentor.fairnessFlags];
    const boost = clamp01(
      flags.reduce((sum, flag) => sum + (ctx.policy.fairnessFlagWeights[flag] ?? 0), 0),
    );
    const value = clamp01(0.7 * headroom + 0.3 * boost);
    const flagNote = boost > 0 ? `, flags ${flags.join("/")}` : "";
    return {
      value,
      explain: `${remainingCapacity(mentor)}/${mentor.capacity} slots free${flagNote}`,
    };
  },
};

export const DEFAULT_FEATURE_SCORERS: readonly FeatureScorer[] = [
  skillFitDirectional,
  levelGapBand,
  availabilityOverlap,
  statedPreference,
  programFairness,
];

/**
 * Replace-by-name, not append. A program adding its own `availability_overlap`
 * means it wants a different one, and silently running both would double-count
 * the feature under one weight.
 */
export function registerScorer(
  scorers: readonly FeatureScorer[],
  scorer: FeatureScorer,
): FeatureScorer[] {
  const without = scorers.filter((s) => s.name !== scorer.name);
  return [...without, scorer];
}

export interface ScoredCandidate {
  features: Record<string, number>;
  explanations: Record<string, string>;
  score: number;
}

/**
 * The weighted composite. Normalised by the weight sum so that turning a
 * feature off changes what is measured, not the scale everything is read on.
 */
export function scoreCandidate(
  input: FeatureScorerInput,
  scorers: readonly FeatureScorer[] = DEFAULT_FEATURE_SCORERS,
): ScoredCandidate {
  const features: Record<string, number> = {};
  const explanations: Record<string, string> = {};
  let weighted = 0;
  let totalWeight = 0;

  for (const scorer of scorers) {
    const result = scorer.score(input);
    const value = clamp01(result.value);
    features[scorer.name] = round4(value);
    explanations[scorer.name] = result.explain;
    const weight = input.ctx.policy.weights[scorer.name] ?? 0;
    if (weight > 0) {
      weighted += weight * value;
      totalWeight += weight;
    }
  }

  return {
    features,
    explanations,
    score: totalWeight === 0 ? 0 : round4(weighted / totalWeight),
  };
}
