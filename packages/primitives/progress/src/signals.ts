import { z } from "zod";
import type { Cadence, ProgramPolicy } from "@mentorship/core";
import type { PairObservations } from "./observations.js";

/**
 * A row of the `signals` table, and the pluggable thing that produces one.
 *
 * The schema is exactly the table's columns — subject_ref, kind, value,
 * confidence, source, observed_at — and deliberately nothing else. Anything a
 * contributor wants to say beyond the number belongs in `basis`, which is
 * recomputed at read time and never persisted: if it were a column, the next
 * contributor would want two, and `signals` would stop being the one place
 * health, risk and dashboards agree on.
 *
 * `value` is constrained to 0..1 here even though the column is unbounded.
 * A composite of weighted components is only meaningful if the components
 * share a scale, and "0..1, higher is better" is the scale. Raw counts that
 * happen to be useful (sessions held, action items closed) are inputs, not
 * signals.
 */

export const SignalSchema = z.object({
  /** `pairing:<id>`, `participant:<id>` — the kind travels in the ref. */
  subjectRef: z.string(),
  kind: z.string(),
  value: z.number().min(0).max(1),
  /** How much this number is worth believing, given how much data it saw. */
  confidence: z.number().min(0).max(1),
  /** `progress.cadenceAdherence@v1` — versioned, so a formula change is traceable. */
  source: z.string(),
  observedAt: z.string(),
});
export type Signal = z.infer<typeof SignalSchema>;

/**
 * A signal plus the working that produced it. `basis` is what turns "0.4" into
 * "2 of 5 expected sessions held", which is most of the answer to "why is this
 * pair amber?" before a model has said a word.
 */
export interface SignalContribution {
  signal: Signal;
  basis: string;
  /** How many observations stood behind it. Drives nothing; explains a lot. */
  sampleSize: number;
}

export interface ContributorContext {
  subjectRef: string;
  asOf: string;
  cadence: Cadence;
  policy: ProgramPolicy;
}

/**
 * Turns observations into signals. One per component, registered rather than
 * hardcoded, so a program with an instrument nobody here anticipated (LMS
 * completions, code review participation) adds a contributor and a weight in
 * policy instead of a branch in the scorer.
 */
export interface SignalContributor<Input> {
  /** The `kind` column it writes, and the key it is weighted by in policy. */
  kind: string;
  /** Versioned: it lands in `source` so an old score stays explicable. */
  version: string;
  /**
   * Zod first — the input shape is a contract, not a comment. The third type
   * argument is `unknown` so a schema with `.default()` on a field still fits:
   * what a contributor is handed and what it works with are allowed to differ.
   */
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>;
  /**
   * Pull this contributor's slice out of the bundle. Returning null means
   * "nothing to say", which is different from "zero" and must stay different:
   * a pair with no action items is not a pair that closed none of them.
   */
  select(observations: PairObservations): Input | null;
  contribute(input: Input, ctx: ContributorContext): SignalContribution[];
}

export interface CollectedSignals {
  signals: Signal[];
  contributions: SignalContribution[];
  /** Kinds that declined to emit, and why, so a blank dashboard is diagnosable. */
  abstained: { kind: string; reason: string }[];
}

/**
 * A contributor with its input type erased, because a registry holds several
 * with different input types. Closing over the typed contributor at
 * registration keeps `select → parse → contribute` type-checked end to end
 * without a cast, which is the whole reason this shape exists.
 */
export interface RegisteredContributor {
  kind: string;
  version: string;
  /** Null means the contributor abstained — see `select`. */
  run(
    observations: PairObservations,
    ctx: ContributorContext,
  ): SignalContribution[] | null;
}

export class SignalContributorRegistry {
  private readonly byKind = new Map<string, RegisteredContributor>();

  register<Input>(contributor: SignalContributor<Input>): this {
    if (this.byKind.has(contributor.kind)) {
      throw new Error(
        `signal contributor for kind "${contributor.kind}" is already registered`,
      );
    }
    this.byKind.set(contributor.kind, {
      kind: contributor.kind,
      version: contributor.version,
      run(observations, ctx) {
        const selected = contributor.select(observations);
        if (selected === null) return null;
        // Parsed on the way in as well as out: a caller assembling
        // observations by hand is the likeliest source of a bad number.
        return contributor.contribute(
          contributor.inputSchema.parse(selected),
          ctx,
        );
      },
    });
    return this;
  }

  kinds(): string[] {
    return [...this.byKind.keys()];
  }

  get(kind: string): RegisteredContributor | undefined {
    return this.byKind.get(kind);
  }

  /**
   * Runs every contributor. One throwing contributor must not cost the whole
   * score: a missing component degrades confidence, which is exactly the
   * signal an operator needs, whereas an exception here would take the
   * dashboard down for every pair in the org.
   */
  run(
    observations: PairObservations,
    ctx: ContributorContext,
  ): CollectedSignals {
    const contributions: SignalContribution[] = [];
    const abstained: { kind: string; reason: string }[] = [];

    for (const contributor of this.byKind.values()) {
      let produced: SignalContribution[];
      try {
        const result = contributor.run(observations, ctx);
        if (result === null) {
          abstained.push({
            kind: contributor.kind,
            reason: "no observations to score",
          });
          continue;
        }
        // Parsed rather than trusted, and inside the try: a contributor that
        // emits 1.4 would silently outvote every other component, and the
        // right response is the same as any other broken contributor —
        // abstain, lower the confidence, keep the dashboard up.
        produced = result.map((contribution) => ({
          ...contribution,
          signal: SignalSchema.parse(contribution.signal),
        }));
      } catch (caught) {
        abstained.push({
          kind: contributor.kind,
          reason: caught instanceof Error ? caught.message : String(caught),
        });
        continue;
      }

      if (produced.length === 0) {
        abstained.push({ kind: contributor.kind, reason: "no signal emitted" });
        continue;
      }
      for (const contribution of produced) {
        // Parsed rather than trusted: a contributor that emits 1.4 would
        // silently outvote every other component in the composite.
        contributions.push({
          ...contribution,
          signal: SignalSchema.parse(contribution.signal),
        });
      }
    }

    return {
      contributions,
      signals: contributions.map((c) => c.signal),
      abstained,
    };
  }
}

export const clamp01 = (n: number): number =>
  n < 0 ? 0 : n > 1 ? 1 : Number.isFinite(n) ? n : 0;

/**
 * Four decimals everywhere a number is compared or displayed. Determinism is
 * already guaranteed by the arithmetic; rounding is so that two runs of the
 * same data are byte-identical in JSON and an admin is never shown 0.6999999.
 */
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Latest signal per kind, by `observedAt`, ties resolved by emission order. */
export function latestByKind(signals: Signal[]): Map<string, Signal> {
  const latest = new Map<string, Signal>();
  for (const signal of signals) {
    const current = latest.get(signal.kind);
    if (!current || Date.parse(signal.observedAt) >= Date.parse(current.observedAt)) {
      latest.set(signal.kind, signal);
    }
  }
  return latest;
}

/** The full series for one kind, oldest first. What trend rules read. */
export function seriesOf(signals: Signal[], kind: string): Signal[] {
  return signals
    .filter((s) => s.kind === kind)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}
