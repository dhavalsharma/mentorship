import { z } from "zod";
import { addDays, iso } from "@mentorship/core";
import {
  ActionItemObservationSchema,
  ActivityObservationSchema,
  GoalObservationSchema,
  PairObservationsSchema,
  ResponseLatencyObservationSchema,
  SessionObservationSchema,
  SurveyResponseSchema,
  pairSubjectRef,
  type PairObservations,
} from "./observations.js";
import {
  SignalContributorRegistry,
  clamp01,
  round4,
  type CollectedSignals,
  type ContributorContext,
  type SignalContribution,
  type SignalContributor,
} from "./signals.js";

/**
 * The six components of ADR-0007, one contributor each. Each owns a `kind`
 * that matches a key in `programPolicy.healthWeights` — that is the only
 * coupling between a contributor and the composite, which is what lets a
 * program add or drop a component without touching the scorer.
 *
 * Two rules every contributor here follows:
 *
 *  1. **Abstain rather than guess.** Returning null from `select` (or emitting
 *     nothing) is how "we have not observed this" is expressed. Emitting 0 for
 *     an unobserved component would be a confident claim that the pair is
 *     failing at something nobody measured.
 *  2. **Report honest confidence.** Confidence is a function of how many
 *     observations the number saw, never a constant. A pair three days into a
 *     cohort should say so loudly; ADR-0007 is explicit that a sparse score
 *     read as a real one is the main way this feature fails.
 */

/** Rolling windows, in days. Long enough to be stable, short enough to move. */
export const CONTRIBUTOR_WINDOWS = {
  actionItemDays: 60,
  reciprocityDays: 60,
  sentimentDays: 90,
  latencyDays: 60,
  /**
   * Cadence adherence is a *rolling* measure: each sample looks back this many
   * cadence intervals. One interval would make adherence binary — a pair
   * either met or did not — and a binary series can never show two consecutive
   * declines, which is the trend the risk rule is looking for.
   */
  cadenceWindowIntervals: 3,
  /** How many samples are emitted, one cadence interval apart. */
  cadenceSamples: 3,
} as const;

/** Observation counts at which a component is considered fully evidenced. */
export const CONFIDENCE_SATURATION = {
  actionItems: 5,
  goalCheckIns: 3,
  activityEvents: 10,
  surveyResponses: 4,
  latencySamples: 5,
} as const;

const DAY_MS = 86_400_000;

const inWindow = (at: string, fromMs: number, toMs: number): boolean => {
  const ms = Date.parse(at);
  return ms > fromMs && ms <= toMs;
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function signal(
  ctx: ContributorContext,
  kind: string,
  version: string,
  value: number,
  confidence: number,
  observedAt: string,
  basis: string,
  sampleSize: number,
): SignalContribution {
  return {
    signal: {
      subjectRef: ctx.subjectRef,
      kind,
      value: round4(clamp01(value)),
      confidence: round4(clamp01(confidence)),
      source: `progress.${kind}@${version}`,
      observedAt,
    },
    basis,
    sampleSize,
  };
}

// ---------------------------------------------------------------------------
// cadence adherence — 0.30, the strongest signal
// ---------------------------------------------------------------------------

export const CadenceAdherenceInputSchema = z.object({
  startedAt: z.string(),
  sessions: z.array(SessionObservationSchema),
});
export type CadenceAdherenceInput = z.infer<typeof CadenceAdherenceInputSchema>;

/**
 * Emits a short series rather than a single aggregate: one sample per cadence
 * interval, each measuring adherence over the trailing window. The composite
 * reads only the latest, but the series is what the trend rule needs, and
 * recomputing "adherence two intervals ago" from raw sessions somewhere else
 * would be a second implementation of the same arithmetic.
 *
 * Samples are anchored to `asOf` and counted backwards, so the newest window
 * is always a full one. Anchoring to `startedAt` would leave a partial window
 * at the end that looks like a collapse in adherence every single time.
 */
export const cadenceAdherenceContributor: SignalContributor<CadenceAdherenceInput> =
  {
    kind: "cadenceAdherence",
    version: "v1",
    inputSchema: CadenceAdherenceInputSchema,
    select(observations) {
      // everyDays === 0 is an ad-hoc program: there is no expectation to
      // adhere to, so scoring adherence would invent a standard.
      if (observations.cadence.everyDays === 0) return null;
      return {
        startedAt: observations.startedAt,
        sessions: observations.sessions,
      };
    },
    contribute(input, ctx) {
      const intervalMs = ctx.cadence.everyDays * DAY_MS;
      const windowMs = intervalMs * CONTRIBUTOR_WINDOWS.cadenceWindowIntervals;
      const asOfMs = Date.parse(ctx.asOf);
      const startedMs = Date.parse(input.startedAt);
      const out: SignalContribution[] = [];

      for (let back = CONTRIBUTOR_WINDOWS.cadenceSamples - 1; back >= 0; back--) {
        const endMs = asOfMs - back * intervalMs;
        const startMs = endMs - windowMs;
        // The slice of the window the pair actually existed for. A pair three
        // days old owes a fifth of a session, not three — pro-rating is what
        // keeps a brand new pairing from reading as a failing one.
        const liveMs = endMs - Math.max(startMs, startedMs);
        if (liveMs <= 0) continue;

        const inWindowSessions = input.sessions.filter((s) =>
          inWindow(s.at, startMs, endMs),
        );
        // no_show and cancelled are not held. They count against adherence on
        // purpose: from the relationship's point of view nothing happened.
        const held = inWindowSessions.filter((s) => s.outcome === "held").length;
        const expected = liveMs / intervalMs;
        const value = expected > 0 ? held / expected : 1;

        out.push(
          signal(
            ctx,
            "cadenceAdherence",
            "v1",
            value,
            liveMs / windowMs,
            iso(endMs),
            `${held} ${ctx.cadence.label} session(s) held against ` +
              `${round4(expected)} expected in the ${round4(liveMs / DAY_MS)} days ` +
              `to ${iso(endMs)}`,
            inWindowSessions.length,
          ),
        );
      }
      return out;
    },
  };

// ---------------------------------------------------------------------------
// action-item completion — 0.20, rolling 60d
// ---------------------------------------------------------------------------

export const ActionItemCompletionInputSchema = z.object({
  items: z.array(ActionItemObservationSchema),
});
export type ActionItemCompletionInput = z.infer<
  typeof ActionItemCompletionInputSchema
>;

/**
 * Closed versus created inside the window — cohort-style, not a running total.
 * A rolling window means one abandoned item from six months ago stops dragging
 * the score forever; chasing that item is `action_item.overdue`'s job, not
 * health's.
 */
export const actionItemCompletionContributor: SignalContributor<ActionItemCompletionInput> =
  {
    kind: "actionItemCompletion",
    version: "v1",
    inputSchema: ActionItemCompletionInputSchema,
    select(observations) {
      return observations.actionItems.length === 0
        ? null
        : { items: observations.actionItems };
    },
    contribute(input, ctx) {
      const asOfMs = Date.parse(ctx.asOf);
      const fromMs = Date.parse(
        addDays(ctx.asOf, -CONTRIBUTOR_WINDOWS.actionItemDays),
      );
      const created = input.items.filter((i) => inWindow(i.createdAt, fromMs, asOfMs));
      if (created.length === 0) return [];

      const closed = created.filter(
        (i) => i.closedAt !== null && Date.parse(i.closedAt) <= asOfMs,
      ).length;

      return [
        signal(
          ctx,
          "actionItemCompletion",
          "v1",
          closed / created.length,
          created.length / CONFIDENCE_SATURATION.actionItems,
          ctx.asOf,
          `${closed} of ${created.length} action items created in the last ` +
            `${CONTRIBUTOR_WINDOWS.actionItemDays} days are closed`,
          created.length,
        ),
      ];
    },
  };

// ---------------------------------------------------------------------------
// goal velocity — 0.20, sparse early
// ---------------------------------------------------------------------------

export const GoalVelocityInputSchema = z.object({
  goals: z.array(GoalObservationSchema),
});
export type GoalVelocityInput = z.infer<typeof GoalVelocityInputSchema>;

/**
 * Progress against the pace the horizon implies, not against 100%. A goal due
 * in six months that is 20% done after one month is on track, and a scorer
 * that cannot express that will mark every new goal red.
 */
export const goalVelocityContributor: SignalContributor<GoalVelocityInput> = {
  kind: "goalVelocity",
  version: "v1",
  inputSchema: GoalVelocityInputSchema,
  select(observations) {
    // A goal with no target date has no expected pace. Not an error — plenty
    // of real goals are open-ended — but nothing to measure velocity against.
    const dated = observations.goals.filter((g) => g.targetAt !== null);
    return dated.length === 0 ? null : { goals: dated };
  },
  contribute(input, ctx) {
    const asOfMs = Date.parse(ctx.asOf);
    const ratios: number[] = [];
    let checkIns = 0;
    let expectedSum = 0;
    let actualSum = 0;

    for (const goal of input.goals) {
      const openedMs = Date.parse(goal.openedAt);
      const targetMs = goal.targetAt === null ? NaN : Date.parse(goal.targetAt);
      if (!Number.isFinite(targetMs) || targetMs <= openedMs) continue;

      const seen = goal.checkIns
        .filter((c) => Date.parse(c.at) <= asOfMs)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      checkIns += seen.length;

      const expected = clamp01((asOfMs - openedMs) / (targetMs - openedMs));
      // The latest check-in is the current position. No check-in at all means
      // no recorded progress, which is a real zero rather than an abstention:
      // the goal exists, has a deadline, and nobody has moved it.
      const actual = seen.length === 0 ? 0 : seen[seen.length - 1]!.progress;
      expectedSum += expected;
      actualSum += actual;
      ratios.push(expected > 0 ? clamp01(actual / expected) : 1);
    }

    if (ratios.length === 0) return [];

    return [
      signal(
        ctx,
        "goalVelocity",
        "v1",
        mean(ratios),
        checkIns / CONFIDENCE_SATURATION.goalCheckIns,
        ctx.asOf,
        `${ratios.length} goal(s) with a horizon: recorded progress ` +
          `${round4(actualSum / ratios.length)} against ` +
          `${round4(expectedSum / ratios.length)} expected by now, from ` +
          `${checkIns} check-in(s)`,
        checkIns,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// reciprocity — 0.15, a proxy
// ---------------------------------------------------------------------------

export const ReciprocityInputSchema = z.object({
  participantCount: z.number().int().min(1),
  activity: z.array(ActivityObservationSchema),
});
export type ReciprocityInput = z.infer<typeof ReciprocityInputSchema>;

/**
 * Balance of effort across the pair: who logs, who schedules, who writes.
 * Scored per activity kind and averaged, because one party doing all the
 * scheduling while both write notes is a different (milder) problem than one
 * party doing everything.
 *
 * `actorRef` is counted and discarded. It never reaches `basis`, a prompt or
 * an output — the finding a program can act on is "this pair is lopsided",
 * not a named person to have a word with.
 */
export const reciprocityContributor: SignalContributor<ReciprocityInput> = {
  kind: "reciprocity",
  version: "v1",
  inputSchema: ReciprocityInputSchema,
  select(observations) {
    return observations.activity.length === 0
      ? null
      : {
          participantCount: observations.participantCount,
          activity: observations.activity,
        };
  },
  contribute(input, ctx) {
    const asOfMs = Date.parse(ctx.asOf);
    const fromMs = Date.parse(
      addDays(ctx.asOf, -CONTRIBUTOR_WINDOWS.reciprocityDays),
    );
    const recent = input.activity.filter((a) => inWindow(a.at, fromMs, asOfMs));
    if (recent.length === 0) return [];

    const byKind = new Map<string, Map<string, number>>();
    for (const event of recent) {
      const counts = byKind.get(event.kind) ?? new Map<string, number>();
      counts.set(event.actorRef, (counts.get(event.actorRef) ?? 0) + 1);
      byKind.set(event.kind, counts);
    }

    const parts: string[] = [];
    const balances: number[] = [];
    for (const [kind, counts] of [...byKind.entries()].sort()) {
      const values = [...counts.values()];
      const total = values.reduce((a, b) => a + b, 0);
      // A participant who never appears contributes an implicit zero, which is
      // the case that matters most — counting only the actors we saw would
      // score a one-sided pair as perfectly balanced.
      const low =
        counts.size < input.participantCount ? 0 : Math.min(...values);
      const balance = total > 0 ? clamp01((low * input.participantCount) / total) : 1;
      balances.push(balance);
      parts.push(`${kind} balance ${round4(balance)} over ${total} event(s)`);
    }

    return [
      signal(
        ctx,
        "reciprocity",
        "v1",
        mean(balances),
        recent.length / CONFIDENCE_SATURATION.activityEvents,
        ctx.asOf,
        parts.join("; "),
        recent.length,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// survey sentiment — 0.10, strong but low volume
// ---------------------------------------------------------------------------

export const SurveySentimentInputSchema = z.object({
  responses: z.array(SurveyResponseSchema),
});
export type SurveySentimentInput = z.infer<typeof SurveySentimentInputSchema>;

/**
 * The aggregate of post-session ratings, and only the aggregate. Invariant 14:
 * sentiment is never attributed to a named person outside the pair, so this
 * contributor never sees a respondent id — `SurveyResponse` does not carry one.
 */
export const surveySentimentContributor: SignalContributor<SurveySentimentInput> =
  {
    kind: "surveySentiment",
    version: "v1",
    inputSchema: SurveySentimentInputSchema,
    select(observations) {
      return observations.surveys.length === 0
        ? null
        : { responses: observations.surveys };
    },
    contribute(input, ctx) {
      const asOfMs = Date.parse(ctx.asOf);
      const fromMs = Date.parse(
        addDays(ctx.asOf, -CONTRIBUTOR_WINDOWS.sentimentDays),
      );
      const recent = input.responses.filter((r) => inWindow(r.at, fromMs, asOfMs));
      if (recent.length === 0) return [];

      return [
        signal(
          ctx,
          "surveySentiment",
          "v1",
          mean(recent.map((r) => r.rating)),
          recent.length / CONFIDENCE_SATURATION.surveyResponses,
          ctx.asOf,
          `mean post-session rating ${round4(mean(recent.map((r) => r.rating)))} ` +
            `across ${recent.length} response(s)`,
          recent.length,
        ),
      ];
    },
  };

// ---------------------------------------------------------------------------
// response latency — 0.05, noisy on purpose
// ---------------------------------------------------------------------------

export const ResponseLatencyInputSchema = z.object({
  samples: z.array(ResponseLatencyObservationSchema),
});
export type ResponseLatencyInput = z.infer<typeof ResponseLatencyInputSchema>;

/**
 * Median, not mean: one holiday should not read as disengagement. Measured
 * against `agreement.responseTimeoutHours` from policy rather than a constant,
 * so a program that expects a reply within a week is not marked down against
 * one that expects a day.
 *
 * ADR-0007 flags this component for review — it may be measuring timezone
 * rather than engagement, which is why it carries the lowest weight.
 */
export const responseLatencyContributor: SignalContributor<ResponseLatencyInput> =
  {
    kind: "responseLatency",
    version: "v1",
    inputSchema: ResponseLatencyInputSchema,
    select(observations) {
      return observations.responseLatencies.length === 0
        ? null
        : { samples: observations.responseLatencies };
    },
    contribute(input, ctx) {
      const asOfMs = Date.parse(ctx.asOf);
      const fromMs = Date.parse(
        addDays(ctx.asOf, -CONTRIBUTOR_WINDOWS.latencyDays),
      );
      const recent = input.samples.filter((s) => inWindow(s.at, fromMs, asOfMs));
      if (recent.length === 0) return [];

      const target = ctx.policy.agreement.responseTimeoutHours;
      const observed = median(recent.map((s) => s.hours));
      const value = target > 0 ? 1 - clamp01(observed / target) : 1;

      return [
        signal(
          ctx,
          "responseLatency",
          "v1",
          value,
          recent.length / CONFIDENCE_SATURATION.latencySamples,
          ctx.asOf,
          `median reply in ${round4(observed)}h against a ${target}h expectation, ` +
            `from ${recent.length} exchange(s)`,
          recent.length,
        ),
      ];
    },
  };

/** The six of ADR-0007. A fork adds to this; it does not edit the scorer. */
export function defaultSignalRegistry(): SignalContributorRegistry {
  return new SignalContributorRegistry()
    .register(cadenceAdherenceContributor)
    .register(actionItemCompletionContributor)
    .register(goalVelocityContributor)
    .register(reciprocityContributor)
    .register(surveySentimentContributor)
    .register(responseLatencyContributor);
}

export function collectSignals(
  observations: PairObservations,
  registry: SignalContributorRegistry = defaultSignalRegistry(),
): CollectedSignals {
  const parsed = PairObservationsSchema.parse(observations);
  return registry.run(parsed, {
    subjectRef: pairSubjectRef(parsed.pairingId),
    asOf: parsed.asOf,
    cadence: parsed.cadence,
    policy: parsed.policy,
  });
}
