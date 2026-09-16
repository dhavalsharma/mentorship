import { z } from "zod";
import { seriesOf, latestByKind, round4, type Signal } from "./signals.js";
import type { HealthScore } from "./health.js";
import type { PairObservations } from "./observations.js";

/**
 * At-risk detection is **rules plus trend, not a classifier** (ADR-0007).
 *
 * The reason is the same one that keeps the model away from the score: a
 * finding about two named employees has to survive being questioned, and
 * "the model thought so" does not. Each rule here states a condition in one
 * sentence and attaches the signals it fired on, so the check is repeatable by
 * a human with the same dashboard.
 *
 * Rules are registered rather than hardcoded into one function, for the same
 * reason contributors are: a program that cares about something these four do
 * not measure should add a rule, not fork the detector.
 */

export const RiskCodeSchema = z.enum([
  "cadence_declining",
  "strained_sentiment_no_session",
  "mentor_pair_ended_early",
  "insufficient_data",
]);
export type RiskCode = z.infer<typeof RiskCodeSchema>;

export const RiskSeveritySchema = z.enum(["info", "watch", "urgent"]);
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

/**
 * A pointer back into the signals that fired the rule. There is no source text
 * to quote here, so invariant 18's evidence span becomes the next best thing:
 * the exact numbers, with their timestamps, so the claim can be checked rather
 * than believed.
 */
export const RiskEvidenceSchema = z.object({
  kind: z.string(),
  /** Null where the evidence is an absence — nothing booked, nothing logged. */
  value: z.number().nullable(),
  observedAt: z.string().nullable(),
  note: z.string(),
});
export type RiskEvidence = z.infer<typeof RiskEvidenceSchema>;

export const RiskFindingSchema = z.object({
  code: RiskCodeSchema,
  severity: RiskSeveritySchema,
  subjectRef: z.string(),
  detectedAt: z.string(),
  summary: z.string(),
  /**
   * Whether this finding needs a person before anything happens. It is the
   * input to `gate()`, and it is decided by the rule rather than by severity
   * alone — an instrumentation gap is worth surfacing and not worth queueing.
   */
  requiresHuman: z.boolean(),
  evidence: z.array(RiskEvidenceSchema),
});
export type RiskFinding = z.infer<typeof RiskFindingSchema>;

export const RiskOptionsSchema = z.object({
  /** Sentiment at or below this is "strained". */
  strainedBelow: z.number().min(0).max(1).default(0.4),
  /** Ignore decline smaller than this — signals are not that precise. */
  declineEpsilon: z.number().min(0).max(1).default(0.01),
  /** Total fall across the two declines that makes it urgent rather than watch. */
  urgentDropAt: z.number().min(0).max(1).default(0.25),
  /** How long a pair may score "unknown" before that is itself a finding. */
  insufficientDataAfterPeriods: z.number().min(0).default(2),
  /** Fallback age threshold in days for ad-hoc programs with no cadence. */
  insufficientDataAfterDays: z.number().min(0).default(60),
});
export type RiskOptions = z.infer<typeof RiskOptionsSchema>;

export interface RiskRuleInput {
  subjectRef: string;
  asOf: string;
  signals: Signal[];
  health: HealthScore;
  observations: PairObservations;
  options: RiskOptions;
}

export interface RiskRule {
  code: RiskCode;
  evaluate(input: RiskRuleInput): RiskFinding | null;
}

const DAY_MS = 86_400_000;

/**
 * Two consecutive periods of declining cadence adherence. Two, not one: a
 * single missed fortnight is a holiday, and a detector that fires on it will
 * be turned off within a month.
 */
export const cadenceDecliningRule: RiskRule = {
  code: "cadence_declining",
  evaluate({ subjectRef, asOf, signals, options }) {
    const series = seriesOf(signals, "cadenceAdherence");
    if (series.length < 3) return null;
    const [first, second, third] = series.slice(-3) as [Signal, Signal, Signal];
    const declining =
      second.value < first.value - options.declineEpsilon &&
      third.value < second.value - options.declineEpsilon;
    if (!declining) return null;

    const drop = first.value - third.value;
    return RiskFindingSchema.parse({
      code: "cadence_declining",
      severity: drop >= options.urgentDropAt ? "urgent" : "watch",
      subjectRef,
      detectedAt: asOf,
      summary:
        `Cadence adherence fell in two consecutive periods, from ` +
        `${round4(first.value)} to ${round4(third.value)}.`,
      requiresHuman: true,
      evidence: [first, second, third].map((s) => ({
        kind: s.kind,
        value: s.value,
        observedAt: s.observedAt,
        note: `adherence ${round4(s.value)} for the period ending ${s.observedAt}`,
      })),
    });
  },
};

/**
 * Strained sentiment with nothing on the calendar. Either alone is tolerable —
 * a rough session followed by another booking is a relationship working
 * through something. It is the combination that goes quiet and stays quiet.
 */
export const strainedSentimentNoSessionRule: RiskRule = {
  code: "strained_sentiment_no_session",
  evaluate({ subjectRef, asOf, signals, observations, options }) {
    const sentiment = latestByKind(signals).get("surveySentiment");
    if (!sentiment) return null;
    if (sentiment.value > options.strainedBelow) return null;
    if (observations.nextSessionAt !== null) return null;

    return RiskFindingSchema.parse({
      code: "strained_sentiment_no_session",
      severity: "urgent",
      subjectRef,
      detectedAt: asOf,
      // Aggregate only. Invariant 14: whose rating was low is not a thing this
      // finding knows, and it must stay that way however it is rendered.
      summary:
        `Post-session ratings are averaging ${round4(sentiment.value)} and no ` +
        `further session is booked.`,
      requiresHuman: true,
      evidence: [
        {
          kind: sentiment.kind,
          value: sentiment.value,
          observedAt: sentiment.observedAt,
          note: `aggregate rating ${round4(sentiment.value)}, strained below ${options.strainedBelow}`,
        },
        {
          kind: "nextSessionAt",
          value: null,
          observedAt: null,
          note: "no future session on the calendar",
        },
      ],
    });
  },
};

/**
 * A mentor with an `ended_early` elsewhere in their portfolio. Context, not
 * blame: the common cause is capacity or a mismatch in what the mentor was
 * asked to do, and both are fixable — which is why the finding exists at the
 * pair level rather than as a mark against a person.
 */
export const mentorPairEndedEarlyRule: RiskRule = {
  code: "mentor_pair_ended_early",
  evaluate({ subjectRef, asOf, observations }) {
    const endedEarly = observations.mentorPortfolio.filter(
      (p) => p.outcome === "ended_early" && p.pairingId !== observations.pairingId,
    );
    if (endedEarly.length === 0) return null;

    return RiskFindingSchema.parse({
      code: "mentor_pair_ended_early",
      severity: "watch",
      subjectRef,
      detectedAt: asOf,
      summary:
        `${endedEarly.length} other pairing(s) with this mentor ended early. ` +
        `Worth checking load and expectations before this one drifts.`,
      requiresHuman: true,
      evidence: endedEarly.map((p) => ({
        kind: "mentorPortfolio",
        value: null,
        observedAt: p.endedAt,
        note: `pairing ${p.pairingId} ended early`,
      })),
    });
  },
};

/**
 * The pair is old enough to have been measured and still cannot be scored.
 * That is a finding about the instrumentation, not about the pair, and it is
 * the one that stops an empty dashboard being read as a calm one.
 */
export const insufficientDataRule: RiskRule = {
  code: "insufficient_data",
  evaluate({ subjectRef, asOf, health, observations, options }) {
    if (health.band !== "unknown") return null;

    const ageDays = (Date.parse(asOf) - Date.parse(observations.startedAt)) / DAY_MS;
    const everyDays = observations.cadence.everyDays;
    const threshold =
      everyDays > 0
        ? everyDays * options.insufficientDataAfterPeriods
        : options.insufficientDataAfterDays;
    if (ageDays < threshold) return null;

    return RiskFindingSchema.parse({
      code: "insufficient_data",
      severity: "info",
      subjectRef,
      detectedAt: asOf,
      summary:
        `${Math.floor(ageDays)} days in and health is still unscorable ` +
        `(confidence ${health.confidence}). Missing: ` +
        `${health.missingKinds.join(", ") || "nothing, but every component is thin"}.`,
      // Deliberately false: this queues nothing. It is a prompt to fix an
      // integration, and routing it to a human reviewer would train them to
      // dismiss the queue that real findings arrive in.
      requiresHuman: false,
      evidence: [
        {
          kind: "confidence",
          value: health.confidence,
          observedAt: asOf,
          note: `coverage ${health.coverage}, density ${health.density}`,
        },
      ],
    });
  },
};

export function defaultRiskRules(): RiskRule[] {
  return [
    cadenceDecliningRule,
    strainedSentimentNoSessionRule,
    mentorPairEndedEarlyRule,
    insufficientDataRule,
  ];
}

export interface DetectRisksInput {
  subjectRef: string;
  asOf: string;
  signals: Signal[];
  health: HealthScore;
  observations: PairObservations;
  options?: Partial<z.input<typeof RiskOptionsSchema>>;
  rules?: RiskRule[];
}

/** Findings ordered urgent → watch → info, then by code, so output is stable. */
export function detectRisks(input: DetectRisksInput): RiskFinding[] {
  const options = RiskOptionsSchema.parse(input.options ?? {});
  const rules = input.rules ?? defaultRiskRules();
  const ruleInput: RiskRuleInput = {
    subjectRef: input.subjectRef,
    asOf: input.asOf,
    signals: input.signals,
    health: input.health,
    observations: input.observations,
    options,
  };

  const order: Record<RiskSeverity, number> = { urgent: 0, watch: 1, info: 2 };
  return rules
    .flatMap((rule) => {
      const finding = rule.evaluate(ruleInput);
      return finding ? [finding] : [];
    })
    .sort(
      (a, b) =>
        order[a.severity] - order[b.severity] || (a.code < b.code ? -1 : 1),
    );
}
