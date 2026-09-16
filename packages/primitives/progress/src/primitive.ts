import { z } from "zod";
import type {
  GateDecision,
  LlmProvider,
  Primitive,
  ProgramPolicy,
} from "@mentorship/core";
import { structuredWithRepair } from "@mentorship/ai";
import {
  PairObservationsSchema,
  pairSubjectRef,
  type PairObservations,
} from "./observations.js";
import {
  SignalContributorRegistry,
  latestByKind,
  type CollectedSignals,
  type Signal,
} from "./signals.js";
import { collectSignals, defaultSignalRegistry } from "./contributors.js";
import {
  HealthScoreSchema,
  computeHealth,
  rankedShortfalls,
  type HealthScore,
  type HealthThresholds,
} from "./health.js";
import {
  RiskFindingSchema,
  RiskOptionsSchema,
  defaultRiskRules,
  detectRisks,
  type RiskCode,
  type RiskFinding,
  type RiskRule,
} from "./risk.js";
import { PROGRESS_EXPLAIN_REF, progressPrompts } from "./prompts.js";

/**
 * The progress & risk primitive.
 *
 * `resolve` does all the arithmetic: contributors → signals → composite →
 * risk rules. By the time `infer` runs, the answer an admin acts on already
 * exists. The model adds a paragraph and a ranking on top of it and can
 * subtract nothing, which is what makes `fallback` a genuine degradation
 * rather than a different product.
 *
 * Read ADR-0007 before changing the shape of this: the separation is the
 * decision, not an implementation detail.
 */

export const InterventionKindSchema = z.enum([
  "adjust_cadence",
  "mediate",
  "offer_training",
  "re_pair",
  "close_out",
]);
export type InterventionKind = z.infer<typeof InterventionKindSchema>;

export const InterventionSchema = z.object({
  kind: InterventionKindSchema,
  /** 1 = do this first. Renumbered densely after the model answers. */
  rank: z.number().int().min(1),
  rationale: z.string().min(1).max(600),
  /**
   * Component kinds or risk codes this rests on, checked against the facts.
   * Required rather than defaulted: invariant 18 wants evidence attached to
   * every inferred claim, and "the model forgot" is not an exemption.
   */
  citedComponents: z.array(z.string()),
});
export type Intervention = z.infer<typeof InterventionSchema>;

/**
 * What the model is allowed to return. Note what is absent: there is no score,
 * no band, no confidence and no weight. A model that tries to send one finds
 * the field stripped by zod rather than merged — the number cannot be
 * influenced because there is no path for it to travel down.
 */
export const ProgressNarrativeSchema = z.object({
  summary: z.string().min(1).max(1500),
  citedComponents: z.array(z.string()).min(1),
  interventions: z.array(InterventionSchema).max(3),
});
export type ProgressNarrative = z.infer<typeof ProgressNarrativeSchema>;

export const ProgressAssessmentSchema = z.object({
  subjectRef: z.string(),
  asOf: z.string(),
  /** Deterministic. Identical whether the model ran, failed or was skipped. */
  health: HealthScoreSchema,
  risks: z.array(RiskFindingSchema),
  narrative: z.object({
    summary: z.string(),
    citedComponents: z.array(z.string()),
  }),
  interventions: z.array(InterventionSchema),
  /** Which path produced the prose. The numbers have only ever had one. */
  generatedBy: z.enum(["model", "deterministic"]),
});
export type ProgressAssessment = z.infer<typeof ProgressAssessmentSchema>;

export interface ProgressTrigger {
  pairingId: string;
  /**
   * Optional: the reader decides what "now" means, and its answer travels in
   * `PairObservations.asOf`. Keeping the clock out of the primitive is what
   * makes a score replayable — and what makes the runner's input hash stable.
   */
  asOf?: string | null;
}

export interface ProgressReader {
  observations(trigger: ProgressTrigger): Promise<PairObservations>;
}

export interface ProgressContext {
  subjectRef: string;
  orgId: string;
  pairingId: string;
  asOf: string;
  observations: PairObservations;
  collected: CollectedSignals;
  health: HealthScore;
  risks: RiskFinding[];
  /** Rendered once in `resolve` so the prompt and the fallback see the same facts. */
  facts: string;
}

export interface ProgressPrimitiveOptions {
  registry?: SignalContributorRegistry;
  rules?: RiskRule[];
  thresholds?: Partial<HealthThresholds>;
  riskOptions?: Partial<z.input<typeof RiskOptionsSchema>>;
}

export function createProgressPrimitive(
  options: ProgressPrimitiveOptions = {},
): Primitive<ProgressTrigger, ProgressContext, ProgressAssessment, ProgressReader> {
  const registry = options.registry ?? defaultSignalRegistry();
  const rules = options.rules ?? defaultRiskRules();

  return {
    name: "progress.assess",
    promptVersion: PROGRESS_EXPLAIN_REF,
    outputSchema: ProgressAssessmentSchema,

    async resolve(trigger, reader) {
      const observations = PairObservationsSchema.parse(
        await reader.observations(trigger),
      );
      const subjectRef = pairSubjectRef(observations.pairingId);
      const collected = collectSignals(observations, registry);
      const health = computeHealth({
        subjectRef,
        asOf: observations.asOf,
        signals: collected.signals,
        policy: observations.policy,
        ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      });
      const risks = detectRisks({
        subjectRef,
        asOf: observations.asOf,
        signals: collected.signals,
        health,
        observations,
        rules,
        ...(options.riskOptions ? { options: options.riskOptions } : {}),
      });

      return {
        subjectRef,
        orgId: observations.orgId,
        pairingId: observations.pairingId,
        asOf: observations.asOf,
        observations,
        collected,
        health,
        risks,
        facts: renderFacts({ health, risks, collected }),
      };
    },

    async infer(ctx, llm) {
      const rendered = progressPrompts.render(PROGRESS_EXPLAIN_REF, {
        facts: ctx.facts,
        interventionKinds: InterventionKindSchema.options.join(", "),
        cadence: ctx.observations.cadence.label,
      });

      const { value } = await structuredWithRepair(llm, {
        ...(rendered.system ? { system: rendered.system } : {}),
        prompt: rendered.prompt,
        schema: ProgressNarrativeSchema,
        schemaName: "ProgressNarrative",
        maxTokens: 900,
      });

      // A citation that resolves to nothing is a fabrication, and a fabricated
      // justification is worse than no paragraph at all. Throwing here lands
      // on the deterministic fallback, which is the correct trade.
      assertCitationsResolve(value, ctx);

      return ProgressAssessmentSchema.parse({
        subjectRef: ctx.subjectRef,
        asOf: ctx.asOf,
        health: ctx.health,
        risks: ctx.risks,
        narrative: {
          summary: value.summary,
          citedComponents: value.citedComponents,
        },
        interventions: rerank(value.interventions),
        generatedBy: "model",
      });
    },

    gate(out, policy) {
      return gateAssessment(out, policy);
    },

    fallback(ctx) {
      return ProgressAssessmentSchema.parse({
        subjectRef: ctx.subjectRef,
        asOf: ctx.asOf,
        health: ctx.health,
        risks: ctx.risks,
        narrative: templatedNarrative(ctx),
        interventions: templatedInterventions(ctx),
        generatedBy: "deterministic",
      });
    },
  };
}

/** The default wiring: the six contributors, the four rules, policy weights. */
export const progressPrimitive = createProgressPrimitive();

/**
 * Anything a human has to decide goes to `approve`; a routine health update is
 * a `log`. Nothing here is ever `auto` — this primitive produces a judgement
 * about two named people, and the most it should do unattended is write the
 * number down.
 */
export function gateAssessment(
  out: ProgressAssessment,
  _policy: ProgramPolicy,
): GateDecision {
  if (out.risks.some((risk) => risk.requiresHuman)) return "approve";
  // Ending or re-forming a relationship is never a log line, even when the
  // rules found nothing: the model proposing it is itself the thing to review.
  if (
    out.interventions.some(
      (i) => i.kind === "re_pair" || i.kind === "close_out",
    )
  ) {
    return "approve";
  }
  return "log";
}

/**
 * Dense, stable ranking. Models emit 1, 1, 3 often enough that trusting the
 * numbers produces a UI with two "first" actions; the order is respected, the
 * numbering is ours.
 */
export function rerank(interventions: Intervention[]): Intervention[] {
  return [...interventions]
    .sort((a, b) => a.rank - b.rank)
    .map((intervention, index) => ({ ...intervention, rank: index + 1 }));
}

export function assertCitationsResolve(
  narrative: ProgressNarrative,
  ctx: ProgressContext,
): void {
  const known = new Set<string>([
    ...ctx.health.components.map((c) => c.kind),
    ...ctx.health.missingKinds,
    ...ctx.risks.map((r) => r.code),
  ]);
  const cited = [
    ...narrative.citedComponents,
    ...narrative.interventions.flatMap((i) => i.citedComponents),
  ];
  const unknown = cited.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new Error(
      `narrative cites components that were never computed: ${unknown.join(", ")}`,
    );
  }
}

/**
 * The facts block. Numbers and their working, no names, no identities — see
 * the note in `prompts.ts`. Rendered in `resolve` so the fallback paragraph
 * and the model's paragraph are provably about the same thing.
 */
export function renderFacts(input: {
  health: HealthScore;
  risks: RiskFinding[];
  collected: CollectedSignals;
}): string {
  const { health, risks, collected } = input;
  const basisByKind = basisOf(collected);

  const lines: string[] = [
    `band: ${health.band}`,
    `score: ${health.score} (green at ${health.thresholds.green}, amber at ${health.thresholds.amber})`,
    `confidence: ${health.confidence} (coverage ${health.coverage}, density ${health.density}; below ${health.thresholds.minConfidence} there is no band)`,
    "",
    "components (kind | weight | value | confidence | basis):",
  ];

  for (const component of rankedShortfalls(health)) {
    lines.push(
      `- ${component.kind} | ${component.weight} | ${component.value} | ` +
        `${component.confidence} | ${basisByKind.get(component.kind) ?? "no basis recorded"}`,
    );
  }

  if (health.missingKinds.length > 0) {
    lines.push("", `not observed at all: ${health.missingKinds.join(", ")}`);
  }
  if (collected.abstained.length > 0) {
    lines.push(
      `contributors with nothing to say: ${collected.abstained
        .map((a) => `${a.kind} (${a.reason})`)
        .join("; ")}`,
    );
  }

  lines.push("", risks.length === 0 ? "risk findings: none" : "risk findings:");
  for (const risk of risks) {
    lines.push(`- [${risk.severity}] ${risk.code}: ${risk.summary}`);
  }

  return lines.join("\n");
}

function basisOf(collected: CollectedSignals): Map<string, string> {
  const latest = latestByKind(collected.signals);
  const basis = new Map<string, string>();
  for (const contribution of collected.contributions) {
    const current = latest.get(contribution.signal.kind);
    if (current && sameSignal(current, contribution.signal)) {
      basis.set(contribution.signal.kind, contribution.basis);
    }
  }
  return basis;
}

const sameSignal = (a: Signal, b: Signal): boolean =>
  a.kind === b.kind && a.observedAt === b.observedAt && a.value === b.value;

/**
 * The paragraph when the model is unavailable, refuses, or the participant has
 * not consented to AI processing. It is duller and it is never wrong: every
 * sentence is a number that was already computed.
 */
export function templatedNarrative(ctx: ProgressContext): {
  summary: string;
  citedComponents: string[];
} {
  const { health, risks } = ctx;
  const ranked = rankedShortfalls(health);
  const worst = ranked[0];
  const sentences: string[] = [];

  if (health.band === "unknown") {
    sentences.push(
      `There is not enough data to score this pair yet (confidence ` +
        `${health.confidence}, below the ${health.thresholds.minConfidence} needed for a band).`,
    );
  } else {
    sentences.push(
      `Health is ${health.band} at ${health.score}, with confidence ${health.confidence}.`,
    );
  }

  if (worst && worst.value < 1) {
    const basis = basisOf(ctx.collected).get(worst.kind);
    sentences.push(
      (
        `The largest drag is ${worst.kind}, scoring ${worst.value} at weight ` +
        `${worst.weight}.${basis ? ` ${capitalise(basis)}.` : ""}`
      ).trim(),
    );
  }
  if (health.missingKinds.length > 0) {
    sentences.push(
      `Not observed at all: ${health.missingKinds.join(", ")}, so the score rests ` +
        `on ${health.components.length} of ${health.components.length + health.missingKinds.length} components.`,
    );
  }
  for (const risk of risks) {
    sentences.push(`${risk.severity.toUpperCase()}: ${risk.summary}`);
  }

  const cited = [
    ...ranked.map((c) => c.kind),
    ...health.missingKinds,
    ...risks.map((r) => r.code),
  ];

  return {
    summary: sentences.join(" "),
    // Never empty: the schema requires at least one citation from the model,
    // and the fallback should not be held to a lower standard.
    citedComponents: cited.length > 0 ? cited : ["confidence"],
  };
}

const capitalise = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);

/**
 * Risk code → the lightest intervention that addresses it.
 *
 * `re_pair` and `close_out` are absent on purpose. Both end a relationship
 * between two people, and the deterministic path has rules, not judgement:
 * proposing one from a rule match alone would be the machine making a call it
 * cannot justify. When the model is available it may propose them, and the
 * gate sends that to a human either way.
 */
const FALLBACK_INTERVENTIONS: Record<RiskCode, InterventionKind | null> = {
  cadence_declining: "adjust_cadence",
  strained_sentiment_no_session: "mediate",
  mentor_pair_ended_early: "offer_training",
  insufficient_data: null,
};

export function templatedInterventions(ctx: ProgressContext): Intervention[] {
  const proposals: Omit<Intervention, "rank">[] = [];
  for (const risk of ctx.risks) {
    const kind = FALLBACK_INTERVENTIONS[risk.code];
    if (!kind) continue;
    if (proposals.some((p) => p.kind === kind)) continue;
    proposals.push({
      kind,
      rationale: `Deterministic response to ${risk.code}: ${risk.summary}`,
      citedComponents: [risk.code],
    });
  }

  const worst = rankedShortfalls(ctx.health)[0];
  if (
    proposals.length === 0 &&
    ctx.health.band === "red" &&
    worst !== undefined
  ) {
    proposals.push({
      kind: "mediate",
      rationale:
        `Health is red at ${ctx.health.score} with no rule firing; ` +
        `${worst.kind} at ${worst.value} is the largest drag.`,
      citedComponents: [worst.kind],
    });
  }

  return proposals.map((proposal, index) => ({ ...proposal, rank: index + 1 }));
}
