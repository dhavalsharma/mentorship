import { describe, expect, it } from "vitest";
import { DeterministicProvider, NullAiRunSink, runPrimitive } from "@mentorship/ai";
import { createMatchingPrimitive } from "@mentorship/primitive-matching";
import type { MatchingPoolInput, MatchingReader } from "@mentorship/primitive-matching";
import { defaultPolicy } from "@mentorship/core";
import { HORIZON, PROGRAM_POLICY, makeMentee, makeMentor } from "./fixtures.js";

/**
 * The primitive's own contract, on top of the pipeline tests: the model can
 * only nudge a score the solver already computed (invariant 17), a failed
 * adjudication for one mentee never loses the rest, and a program that has
 * not yet earned trust keeps a human between a proposal and an invite.
 */

function pool(over: Partial<MatchingPoolInput> = {}): MatchingPoolInput {
  return {
    cohortId: "coh_1",
    orgId: "org_1",
    horizon: HORIZON,
    policy: PROGRAM_POLICY,
    mentors: [makeMentor({ participantId: "mentor_1", capacity: 2 })],
    mentees: [makeMentee({ participantId: "mentee_1" }), makeMentee({ participantId: "mentee_2" })],
    ...over,
  };
}

function reader(input: MatchingPoolInput): MatchingReader {
  return { matchingPool: async () => input };
}

function adjudicationValue(mentorId: string, adjustment: number) {
  return {
    candidates: [
      {
        mentorId,
        adjustment,
        rationale: "Strong overlap on the stated goal.",
        riskFlags: [],
        evidence: [],
      },
    ],
  };
}

describe("the model can nudge, never allocate", () => {
  it("clamps an adjustment far outside policy down to the bound", async () => {
    const input = pool();
    const llm = new DeterministicProvider({
      scripted: [{ when: "", value: adjudicationValue("mentor_1", 0.9) }],
    });
    const primitive = createMatchingPrimitive();
    const result = await runPrimitive({
      primitive,
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm,
      policy: PROGRAM_POLICY,
      orgId: input.orgId,
    });

    expect(result.degraded).toBe(false);
    expect(result.output.adjudicated).toBe(true);
    const record = result.output.candidates.find(
      (c) => c.menteeId === "mentee_1" && c.mentorId === "mentor_1",
    )!;
    expect(record.adjustment).toBeLessThanOrEqual(0.05);
  });

  it("keeps the deterministic assignment when the model is unavailable", async () => {
    const input = pool();
    const deterministic = await createMatchingPrimitive().resolve(
      { cohortId: input.cohortId },
      reader(input),
    );
    const fallbackOutput = createMatchingPrimitive().fallback(deterministic);

    const result = await runPrimitive({
      primitive: createMatchingPrimitive(),
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm: new DeterministicProvider({ failWith: new Error("vendor down") }),
      policy: PROGRAM_POLICY,
      orgId: input.orgId,
    });

    // infer() absorbs a per-mentee failure rather than throwing, so the run
    // itself is not `degraded` — but every mentee failed adjudication, so
    // the output falls back to the plain solve, byte for byte.
    expect(result.degraded).toBe(false);
    expect(result.output.adjudicated).toBe(false);
    expect(result.output.assignments).toEqual(fallbackOutput.assignments);
  });

  it("does not let one mentee's adjudication failure discard another's", async () => {
    const input = pool();
    let calls = 0;
    const llm: DeterministicProvider = new DeterministicProvider({
      scripted: [{ when: "", value: adjudicationValue("mentor_1", 0.02) }],
    });
    const originalStructured = llm.structured.bind(llm);
    // Both the first attempt and its one repair fail for the first mentee
    // (calls 1-2); the second mentee's attempt (call 3) succeeds.
    llm.structured = (async (request: Parameters<typeof originalStructured>[0]) => {
      calls++;
      if (calls <= 2) throw new Error("vendor down for this candidate");
      return originalStructured(request);
    }) as typeof llm.structured;

    const result = await runPrimitive({
      primitive: createMatchingPrimitive(),
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm,
      policy: PROGRAM_POLICY,
      orgId: input.orgId,
    });

    // The run as a whole still succeeds: infer() absorbs the one mentee's
    // failure and the schema still validates, so the caller never sees
    // `degraded` — but the failure is counted, not hidden.
    expect(result.degraded).toBe(false);
    expect(result.output.adjudicationErrors).toBe(1);
    expect(result.output.assignments.length).toBeGreaterThan(0);
  });

  it("discards an adjudicated id outside the shortlist it was shown", async () => {
    const input = pool();
    const llm = new DeterministicProvider({
      scripted: [{ when: "", value: adjudicationValue("someone_not_on_the_shortlist", 0.05) }],
    });
    const result = await runPrimitive({
      primitive: createMatchingPrimitive(),
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm,
      policy: PROGRAM_POLICY,
      orgId: input.orgId,
    });

    const record = result.output.candidates.find((c) => c.mentorId === "mentor_1")!;
    expect(record.adjustment).toBe(0);
    expect(record.rationale).toBeNull();
  });
});

describe("gating", () => {
  it("requires admin approval by default — a proposal, not an invite", async () => {
    const input = pool();
    const result = await runPrimitive({
      primitive: createMatchingPrimitive(),
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm: new DeterministicProvider({ scripted: [{ when: "", value: adjudicationValue("mentor_1", 0) }] }),
      policy: PROGRAM_POLICY,
      orgId: input.orgId,
    });
    expect(result.gate).toBe("approve");
  });

  it("runs automatically once a program has turned admin approval off", async () => {
    const openPolicy = defaultPolicy({ pairing: { requireAdminApproval: false } });
    const input = pool({ policy: openPolicy });
    const result = await runPrimitive({
      primitive: createMatchingPrimitive(),
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm: new DeterministicProvider({ scripted: [{ when: "", value: adjudicationValue("mentor_1", 0) }] }),
      policy: openPolicy,
      orgId: input.orgId,
    });
    expect(result.gate).toBe("auto");
  });
});

describe("the run record", () => {
  it("stamps the prompt version and hashes the resolved roster, not row order", async () => {
    const runs = new NullAiRunSink();
    const shuffled = pool({
      mentees: [makeMentee({ participantId: "mentee_2" }), makeMentee({ participantId: "mentee_1" })],
    });
    const sorted = pool();
    const llm = () =>
      new DeterministicProvider({ scripted: [{ when: "", value: adjudicationValue("mentor_1", 0) }] });

    await runPrimitive({
      primitive: createMatchingPrimitive(),
      trigger: { cohortId: sorted.cohortId },
      reader: reader(sorted),
      llm: llm(),
      policy: PROGRAM_POLICY,
      orgId: sorted.orgId,
      runs,
    });
    await runPrimitive({
      primitive: createMatchingPrimitive(),
      trigger: { cohortId: shuffled.cohortId },
      reader: reader(shuffled),
      llm: llm(),
      policy: PROGRAM_POLICY,
      orgId: shuffled.orgId,
      runs,
    });

    expect(runs.runs).toHaveLength(2);
    expect(runs.runs[0]!.primitive).toBe("matching.propose");
    expect(runs.runs[0]!.promptVersion).toMatch(/@v\d+/);
    expect(runs.runs[0]!.inputHash).toBe(runs.runs[1]!.inputHash);
  });
});
