import { describe, expect, it } from "vitest";
import { defaultPolicy } from "@mentorship/core";
import { DeterministicProvider } from "@mentorship/ai";
import { commitMatchingRound, runMatchingRound } from "@mentorship/primitive-matching";
import type { MatchingCommitSink, MatchingOutput } from "@mentorship/primitive-matching";
import type { MatchingPoolInput, MatchingReader } from "@mentorship/primitive-matching";
import { HORIZON, PROGRAM_POLICY, makeMentee, makeMentor } from "./fixtures.js";

/**
 * The bridge from a computed round to an actual pairing — the piece that
 * lets matching produce the same `pair.activated` an import does (ADR-0003).
 * A fake sink stands in for `World`/a real `RosterSink`; the interfaces are
 * structurally identical (see round.ts's doc comment), so nothing here is
 * mocking behaviour the real implementation does not have.
 */

class FakeSink implements MatchingCommitSink {
  pairings: {
    pairingId: string;
    mentorParticipantId: string;
    menteeParticipantId: string;
    state: "active" | "offered";
    origin: "matched";
    notes: string | null;
    importFileHash: string;
  }[] = [];
  announcements: { pairingId: string; state: string; participantIds: string[] }[] = [];
  private seq = 0;

  async createPairing(input: Parameters<MatchingCommitSink["createPairing"]>[0]) {
    const pairingId = `pai_${++this.seq}`;
    this.pairings.push({
      pairingId,
      mentorParticipantId: input.mentorParticipantId,
      menteeParticipantId: input.menteeParticipantId,
      state: input.state,
      origin: input.origin,
      notes: input.notes,
      importFileHash: input.importFileHash,
    });
    return { pairingId };
  }

  async announce(input: Parameters<MatchingCommitSink["announce"]>[0]) {
    this.announcements.push(input);
  }
}

function pool(over: Partial<MatchingPoolInput> = {}): MatchingPoolInput {
  return {
    cohortId: "coh_1",
    orgId: "org_1",
    horizon: HORIZON,
    policy: PROGRAM_POLICY,
    mentors: [makeMentor({ participantId: "mentor_1", capacity: 2 })],
    mentees: [makeMentee({ participantId: "mentee_1" })],
    ...over,
  };
}

function reader(input: MatchingPoolInput): MatchingReader {
  return { matchingPool: async () => input };
}

describe("commitMatchingRound", () => {
  const output: MatchingOutput = {
    cohortId: "coh_1",
    orgId: "org_1",
    asOf: HORIZON.start,
    solver: "min_cost_flow",
    adjudicated: false,
    adjudicationErrors: 0,
    assignments: [
      {
        menteeId: "mentee_1",
        mentorId: "mentor_1",
        score: 0.8,
        deterministicScore: 0.8,
        rank: 1,
        rationale: "Strong fit on the stated goal.",
        riskFlags: [],
      },
    ],
    unmatched: [],
    mentorLoad: [{ mentorId: "mentor_1", assigned: 1, priorLoad: 0, capacity: 2 }],
    candidates: [],
  };

  it("creates a pairing per assignment and announces it exactly like an import would", async () => {
    const sink = new FakeSink();
    const result = await commitMatchingRound(output, sink, { pairsStart: "active" });

    expect(result.created).toEqual([
      { menteeId: "mentee_1", mentorId: "mentor_1", pairingId: "pai_1" },
    ]);
    expect(sink.pairings[0]).toMatchObject({
      mentorParticipantId: "mentor_1",
      menteeParticipantId: "mentee_1",
      state: "active",
      origin: "matched",
      notes: "Strong fit on the stated goal.",
    });
    expect(sink.announcements).toEqual([
      { pairingId: "pai_1", state: "active", participantIds: ["mentor_1", "mentee_1"] },
    ]);
  });

  it("commits nothing for an empty round", async () => {
    const sink = new FakeSink();
    const result = await commitMatchingRound({ ...output, assignments: [] }, sink, {
      pairsStart: "active",
    });
    expect(result.created).toEqual([]);
    expect(sink.pairings).toEqual([]);
  });
});

describe("runMatchingRound", () => {
  it("does not commit while the gate requires admin approval — the default", async () => {
    const input = pool();
    const sink = new FakeSink();
    const result = await runMatchingRound({
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm: new DeterministicProvider({ failWith: new Error("vendor down") }),
      policy: PROGRAM_POLICY,
      orgId: input.orgId,
      sink,
    });

    expect(result.gate).toBe("approve");
    expect(result.committed).toBeNull();
    expect(sink.pairings).toEqual([]);
    expect(result.output.assignments.length).toBeGreaterThan(0);
  });

  it("commits straight through once a program has turned admin approval off", async () => {
    const openPolicy = defaultPolicy({ pairing: { requireAdminApproval: false } });
    const input = pool({ policy: openPolicy });
    const sink = new FakeSink();
    const result = await runMatchingRound({
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm: new DeterministicProvider({ failWith: new Error("vendor down") }),
      policy: openPolicy,
      orgId: input.orgId,
      sink,
    });

    expect(result.gate).toBe("auto");
    expect(result.committed).not.toBeNull();
    expect(result.committed!.created.length).toBe(result.output.assignments.length);
    expect(sink.pairings.length).toBe(result.output.assignments.length);
    expect(sink.announcements.every((a) => a.state === "active")).toBe(true);
  });

  it("honours pairsStart: 'offered' for a program that wants both sides to accept first", async () => {
    const openPolicy = defaultPolicy({ pairing: { requireAdminApproval: false } });
    const input = pool({ policy: openPolicy });
    const sink = new FakeSink();
    const result = await runMatchingRound({
      trigger: { cohortId: input.cohortId },
      reader: reader(input),
      llm: new DeterministicProvider({ failWith: new Error("vendor down") }),
      policy: openPolicy,
      orgId: input.orgId,
      sink,
      pairsStart: "offered",
    });

    expect(result.committed).not.toBeNull();
    expect(sink.announcements.every((a) => a.state === "offered")).toBe(true);
  });
});
