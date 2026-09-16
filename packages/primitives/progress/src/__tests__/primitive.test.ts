import { describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import { DeterministicProvider, NullAiRunSink, runPrimitive } from "@mentorship/ai";
import {
  createProgressPrimitive,
  progressPrimitive,
  rerank,
  type ProgressReader,
} from "@mentorship/primitive-progress";
import { AS_OF, healthyObservations, mixedObservations } from "./fixtures.js";

/**
 * The stance ADR-0007 takes, tested where it could actually be broken: the
 * model writes the paragraph and ranks the interventions, and cannot move the
 * number by any route — not by returning one, not by failing, not by being
 * switched off.
 */

const policy = defaultPolicy({});

function reader(observations: ReturnType<typeof healthyObservations>): ProgressReader {
  return { observations: async () => observations };
}

/** A narrative that cites a component the fixture really has. */
function narrative(over: Record<string, unknown> = {}) {
  return {
    summary: "Cadence is holding and action items are being closed.",
    citedComponents: ["cadenceAdherence"],
    interventions: [
      {
        kind: "adjust_cadence",
        rationale: "Sessions are slightly spaced out.",
        rank: 2,
        citedComponents: ["cadenceAdherence"],
      },
    ],
    ...over,
  };
}

async function run(
  observations: ReturnType<typeof healthyObservations>,
  llm: DeterministicProvider,
  runs = new NullAiRunSink(),
) {
  return runPrimitive({
    primitive: progressPrimitive,
    trigger: { pairingId: observations.pairingId },
    reader: reader(observations),
    llm,
    policy,
    orgId: observations.orgId,
    runs,
  });
}

describe("the model cannot own the number", () => {
  it("keeps the computed score even when the model tries to return its own", async () => {
    const observations = mixedObservations();
    const deterministic = await progressPrimitive.resolve(
      { pairingId: observations.pairingId },
      reader(observations),
    );

    // The model is asked for prose and hands back a score as well. The output
    // schema has no place to put it, so it cannot arrive — this asserts the
    // structural guarantee rather than a runtime scrub.
    const llm = new DeterministicProvider({
      scripted: [
        {
          when: "",
          value: narrative({ score: 0.99, band: "green", health: { score: 0.99 } }),
        },
      ],
    });

    const result = await run(observations, llm);
    expect(result.degraded).toBe(false);
    expect(result.output.generatedBy).toBe("model");
    expect(result.output.health.score).toBe(deterministic.health.score);
    expect(result.output.health.band).toBe(deterministic.health.band);
    expect(JSON.stringify(result.output.health)).not.toContain("0.99");
  });

  it("produces the same number whether the model ran, failed, or never ran", async () => {
    const observations = mixedObservations();

    const succeeded = await run(
      observations,
      new DeterministicProvider({ scripted: [{ when: "", value: narrative() }] }),
    );
    const failed = await run(
      observations,
      new DeterministicProvider({ failWith: new Error("vendor down") }),
    );
    const skipped = await runPrimitive({
      primitive: progressPrimitive,
      trigger: { pairingId: observations.pairingId },
      reader: reader(observations),
      llm: new DeterministicProvider({ scripted: [{ when: "", value: narrative() }] }),
      policy,
      orgId: observations.orgId,
      inferenceEnabled: false,
    });

    expect(failed.degraded).toBe(true);
    expect(skipped.degraded).toBe(true);
    expect(failed.output.health).toEqual(succeeded.output.health);
    expect(skipped.output.health).toEqual(succeeded.output.health);
    expect(failed.output.risks).toEqual(succeeded.output.risks);
  });

  it("still explains itself when the model is unavailable", async () => {
    // Mixed-but-fine has nothing to recommend; give it a real finding —
    // strained sentiment with nothing booked — so the fallback path has
    // something to say and this asserts it says it.
    const observations = mixedObservations({
      surveys: [{ at: AS_OF, rating: 0.2 }],
      nextSessionAt: null,
    });
    const result = await run(
      observations,
      new DeterministicProvider({ failWith: new Error("timeout") }),
    );
    expect(result.output.generatedBy).toBe("deterministic");
    expect(result.output.narrative.summary.length).toBeGreaterThan(0);
    // A degraded run is still an actionable one.
    expect(result.output.interventions.length).toBeGreaterThan(0);
  });
});

describe("citations", () => {
  it("falls back rather than shipping a paragraph that cites a component it does not have", async () => {
    const llm = new DeterministicProvider({
      scripted: [
        { when: "", value: narrative({ citedComponents: ["vibesIndex"] }) },
      ],
    });
    const result = await run(mixedObservations(), llm);

    // A fabricated justification is worse than no paragraph at all.
    expect(result.degraded).toBe(true);
    expect(result.output.generatedBy).toBe("deterministic");
  });
});

describe("interventions", () => {
  it("reranks by priority, so the admin queue is ordered by the model's judgement", () => {
    const ranked = rerank([
      { kind: "mediate", rationale: "b", rank: 3, citedComponents: [] },
      { kind: "re_pair", rationale: "a", rank: 1, citedComponents: [] },
      { kind: "offer_training", rationale: "c", rank: 2, citedComponents: [] },
    ]);
    expect(ranked.map((i) => i.kind)).toEqual(["re_pair", "offer_training", "mediate"]);
  });
});

describe("gating", () => {
  it("sends a healthy assessment to the log, not to a human's queue", async () => {
    const result = await run(
      healthyObservations(),
      new DeterministicProvider({ scripted: [{ when: "", value: narrative() }] }),
    );
    expect(result.gate).toBe("log");
  });

  it("asks for a human when something is actually at risk", async () => {
    const observations = mixedObservations();
    const resolved = await progressPrimitive.resolve(
      { pairingId: observations.pairingId },
      reader(observations),
    );
    const assessment = progressPrimitive.fallback(resolved);

    const gate = progressPrimitive.gate(
      { ...assessment, risks: [...assessment.risks, urgentRisk(assessment.subjectRef)] },
      policy,
    );
    expect(gate).toBe("approve");
  });
});

describe("the run record", () => {
  it("stamps the prompt version, so an old score stays explicable", async () => {
    const runs = new NullAiRunSink();
    await run(
      mixedObservations(),
      new DeterministicProvider({ scripted: [{ when: "", value: narrative() }] }),
      runs,
    );
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.primitive).toBe("progress.assess");
    expect(runs.runs[0]!.promptVersion).toMatch(/@v\d+/);
  });

  it("hashes the same observations to the same input, so a replay is recognisable", async () => {
    const runs = new NullAiRunSink();
    const llm = new DeterministicProvider({ scripted: [{ when: "", value: narrative() }] });
    await run(mixedObservations(), llm, runs);
    await run(mixedObservations(), llm, runs);
    expect(runs.runs[0]!.inputHash).toBe(runs.runs[1]!.inputHash);
  });
});

describe("a bespoke program", () => {
  it("can supply its own contributors and rules without forking the primitive", async () => {
    const custom = createProgressPrimitive({ rules: [] });
    const observations = mixedObservations();
    const ctx = await custom.resolve(
      { pairingId: observations.pairingId },
      reader(observations),
    );
    // No rules registered means no findings, and the score still computes.
    expect(ctx.risks).toEqual([]);
    expect(ctx.health.components.length).toBeGreaterThan(0);
  });
});

function urgentRisk(subjectRef: string) {
  return {
    subjectRef,
    code: "cadence_declining" as const,
    severity: "urgent" as const,
    detectedAt: AS_OF,
    summary: "Two consecutive periods of declining adherence.",
    evidence: [],
    requiresHuman: true,
  };
}
