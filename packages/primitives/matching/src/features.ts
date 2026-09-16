import { overlapHoursPerFortnight } from "./availability.js";
import { remainingCapacity } from "./policy.js";
import type { LlmProvider } from "@mentorship/core";
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
  /**
   * Precomputed narrative embeddings, keyed by `participantId`. Optional: a
   * program with no embedding pipeline configured yet simply runs without
   * this feature contributing anything. Computing embeddings is a network
   * call and `scoreCandidate` is synchronous by design (it runs in a nested
   * loop over every mentor x mentee pair) — a caller resolves this map once,
   * up front, with `embedNarratives`, and threads it in here.
   */
  narrativeEmbeddings?: ReadonlyMap<string, number[]>;
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

/**
 * Cosine similarity, rescaled from [-1,1] to [0,1] so it sits on the same
 * scale every other feature score is documented to use — a raw cosine of 0
 * (orthogonal, i.e. "no signal either way") would otherwise read as the same
 * number as this codebase's "actively bad" floor, which it is not.
 *
 * Mismatched lengths and zero vectors are degenerate inputs, not error cases:
 * an embedding pipeline that returns a truncated or all-zero vector should
 * not take matching down with it, so both return the neutral midpoint (0.5)
 * rather than throwing — the same defensive posture as `skillFitDirectional`
 * scoring a thin profile as neutral rather than penalising it.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0.5;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0.5;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Guard float drift pushing raw slightly outside [-1, 1] before rescaling.
  const clamped = raw < -1 ? -1 : raw > 1 ? 1 : raw;
  return (clamped + 1) / 2;
}

/**
 * Narrative similarity via cosine over precomputed embeddings (roadmap Phase
 * 3: "narrative cosine via pgvector"). The pgvector storage/query side is
 * deliberately not built here — nothing in this sandbox can verify it — so
 * this scorer only consumes whatever embeddings a caller has already resolved
 * into `ScoringContext.narrativeEmbeddings` via `embedNarratives`. That keeps
 * the scorer itself synchronous and the embedding call outside the hot loop.
 *
 * Not in `DEFAULT_MATCHING_WEIGHTS`: per the policy comment on `weights`, a
 * scorer with no entry still runs and is still measured — it just contributes
 * nothing to the score. An embedding is exactly the kind of feature that
 * should prove itself against real cohorts before it gets to move a match,
 * per invariant 17.
 */
export const narrativeSimilarity: FeatureScorer = {
  name: "narrative_similarity",
  score({ mentee, mentor, ctx }) {
    const embeddings = ctx.narrativeEmbeddings;
    const menteeVector = embeddings?.get(mentee.participantId);
    const mentorVector = embeddings?.get(mentor.participantId);
    if (!menteeVector || !mentorVector) {
      return { value: 0, explain: "narrative embeddings unavailable for this pair" };
    }
    const similarity = cosineSimilarity(menteeVector, mentorVector);
    return {
      value: clamp01(similarity),
      explain: `narrative cosine similarity ${round4(similarity)}`,
    };
  },
};

/**
 * Resolves embeddings for a batch of participant narratives, once, up front —
 * outside the synchronous scoring path entirely. The caller passes the
 * resulting map into `ScoringContext.narrativeEmbeddings` before running the
 * pipeline.
 *
 * Skips blank narratives (nothing useful to embed) and providers with no
 * `embed` method (not every `LlmProvider` implements it) by returning an
 * empty map — same "degrade, never throw" posture as everywhere else a
 * capability might not exist for a given tenant.
 */
export async function embedNarratives(
  llm: LlmProvider,
  people: { participantId: string; narrative: string }[],
): Promise<Map<string, number[]>> {
  if (!llm.embed) return new Map();

  const withNarrative = people.filter((p) => p.narrative.trim().length > 0);
  if (withNarrative.length === 0) return new Map();

  const { vectors } = await llm.embed(withNarrative.map((p) => p.narrative));
  const result = new Map<string, number[]>();
  withNarrative.forEach((person, index) => {
    const vector = vectors[index];
    if (vector) result.set(person.participantId, vector);
  });
  return result;
}

export const DEFAULT_FEATURE_SCORERS: readonly FeatureScorer[] = [
  skillFitDirectional,
  levelGapBand,
  availabilityOverlap,
  statedPreference,
  programFairness,
  narrativeSimilarity,
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
