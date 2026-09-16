import { z } from "zod";
import type { ProgramPolicy } from "@mentorship/core";
import { SignalSchema, latestByKind, round4, type Signal } from "./signals.js";

/**
 * The composite. A weighted mean of observable components, computed from
 * `signals` and nothing else, with a confidence derived from how much data
 * stood behind it.
 *
 * The property that matters is in the signature: `computeHealth` takes signals
 * and a policy and returns a number. No model, no clock, no I/O. The same
 * inputs give the same output today, next quarter, and when an admin asks you
 * to justify a decision that was made on last March's score — which is the
 * entire argument of ADR-0007.
 */

export const HealthBandSchema = z.enum(["green", "amber", "red", "unknown"]);
export type HealthBand = z.infer<typeof HealthBandSchema>;

export const HealthThresholdsSchema = z.object({
  /** At or above this, green. */
  green: z.number().min(0).max(1),
  /** At or above this, amber; below it, red. */
  amber: z.number().min(0).max(1),
  /**
   * Below this confidence there is no band at all. A pair three days into a
   * cohort gets "unknown", not a green that someone will act on. ADR-0007
   * lists surfacing confidence as the thing that decides whether this feature
   * helps or misleads.
   */
  minConfidence: z.number().min(0).max(1),
});
export type HealthThresholds = z.infer<typeof HealthThresholdsSchema>;

/**
 * Defaults as a named constant rather than `.default()` inside the schema, so
 * that the schema's input and output types stay identical — it is embedded in
 * the primitive's output schema, and `Primitive.outputSchema` is typed
 * `ZodType<Out>`, which a schema with defaults does not satisfy.
 *
 * These belong in `programPolicy` next to `healthWeights` eventually. They are
 * not there yet because `ProgramPolicySchema` lives in `core`; adding them is
 * a one-line change there and a `thresholds` passthrough here.
 */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  green: 0.7,
  amber: 0.45,
  minConfidence: 0.35,
};

export function resolveThresholds(
  overrides: Partial<HealthThresholds> = {},
): HealthThresholds {
  return HealthThresholdsSchema.parse({
    ...DEFAULT_HEALTH_THRESHOLDS,
    ...overrides,
  });
}

export const HealthComponentSchema = z.object({
  kind: z.string(),
  /** Straight from `programPolicy.healthWeights`. Never a constant. */
  weight: z.number(),
  /** Re-normalised across the components actually present. */
  normalisedWeight: z.number(),
  value: z.number(),
  confidence: z.number(),
  /** `normalisedWeight * value` — what this component put into the score. */
  contribution: z.number(),
  /** `normalisedWeight * (1 - value)` — what it took out. Ranks the "why". */
  shortfall: z.number(),
  source: z.string(),
  observedAt: z.string(),
});
export type HealthComponent = z.infer<typeof HealthComponentSchema>;

export const HealthScoreSchema = z.object({
  subjectRef: z.string(),
  asOf: z.string(),
  score: z.number().min(0).max(1),
  band: HealthBandSchema,
  confidence: z.number().min(0).max(1),
  /** Share of configured weight that has any observation behind it. */
  coverage: z.number().min(0).max(1),
  /** Mean per-component confidence among those present. */
  density: z.number().min(0).max(1),
  components: z.array(HealthComponentSchema),
  /** Configured, weighted, and unobserved. The other half of "why". */
  missingKinds: z.array(z.string()),
  /** Observed but carrying no weight in this program — usually a config slip. */
  unweightedKinds: z.array(z.string()),
  thresholds: HealthThresholdsSchema,
});
export type HealthScore = z.infer<typeof HealthScoreSchema>;

export interface ComputeHealthInput {
  subjectRef: string;
  asOf: string;
  signals: Signal[];
  policy: ProgramPolicy;
  thresholds?: Partial<HealthThresholds>;
}

export function computeHealth(input: ComputeHealthInput): HealthScore {
  const thresholds = resolveThresholds(input.thresholds ?? {});
  const signals = input.signals.map((s) => SignalSchema.parse(s));
  const latest = latestByKind(signals);

  // A weight of zero is a program saying "do not count this", which is not the
  // same as a component being missing: it should not drag coverage down.
  const configured = Object.entries(input.policy.healthWeights)
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const configuredWeight = configured.reduce((sum, [, w]) => sum + w, 0);
  const present = configured.flatMap(([kind, weight]) => {
    const found = latest.get(kind);
    return found ? [{ kind, weight, signal: found }] : [];
  });
  const presentWeight = present.reduce((sum, p) => sum + p.weight, 0);

  const components: HealthComponent[] = present.map(({ kind, weight, signal }) => {
    const normalisedWeight = presentWeight > 0 ? weight / presentWeight : 0;
    return {
      kind,
      weight: round4(weight),
      normalisedWeight: round4(normalisedWeight),
      value: round4(signal.value),
      confidence: round4(signal.confidence),
      contribution: round4(normalisedWeight * signal.value),
      shortfall: round4(normalisedWeight * (1 - signal.value)),
      source: signal.source,
      observedAt: signal.observedAt,
    };
  });

  // Weights are re-normalised over the components present rather than divided
  // by the full configured weight. Otherwise a missing component would look
  // identical to a component scoring zero, and a new pair would read as a
  // failing one. Absence belongs in `confidence`, not in the score.
  const score =
    presentWeight > 0
      ? present.reduce((sum, p) => sum + p.weight * p.signal.value, 0) / presentWeight
      : 0;
  const density =
    presentWeight > 0
      ? present.reduce((sum, p) => sum + p.weight * p.signal.confidence, 0) /
        presentWeight
      : 0;
  const coverage = configuredWeight > 0 ? presentWeight / configuredWeight : 0;
  // Two ways to be unsure, and both have to count: we may have seen only a
  // sliver of what matters (coverage), or plenty of components each resting on
  // two data points (density). Multiplying keeps either one able to veto.
  const confidence = coverage * density;

  const configuredKinds = new Set(configured.map(([kind]) => kind));
  const missingKinds = configured
    .map(([kind]) => kind)
    .filter((kind) => !latest.has(kind));
  const unweightedKinds = [...latest.keys()]
    .filter((kind) => !configuredKinds.has(kind))
    .sort();

  return HealthScoreSchema.parse({
    subjectRef: input.subjectRef,
    asOf: input.asOf,
    score: round4(score),
    band: bandFor(round4(score), round4(confidence), thresholds),
    confidence: round4(confidence),
    coverage: round4(coverage),
    density: round4(density),
    components,
    missingKinds,
    unweightedKinds,
    thresholds,
  });
}

export function bandFor(
  score: number,
  confidence: number,
  thresholds: HealthThresholds,
): HealthBand {
  if (confidence < thresholds.minConfidence) return "unknown";
  if (score >= thresholds.green) return "green";
  if (score >= thresholds.amber) return "amber";
  return "red";
}

/** Components ordered by how much they cost the score. The "why", ranked. */
export function rankedShortfalls(health: HealthScore): HealthComponent[] {
  return [...health.components].sort(
    (a, b) => b.shortfall - a.shortfall || (a.kind < b.kind ? -1 : 1),
  );
}
