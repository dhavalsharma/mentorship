import { describe, expect, it } from "vitest";
import {
  MatchingOutputSchema,
  checkConstraints,
  evaluatePool,
  greedyAssignmentSolver,
  remainingCapacity,
  runDeterministicPipeline,
  shortlistFor,
  type MatchingContext,
  type MatchingOutput,
} from "@mentorship/primitive-matching";
import {
  HORIZON_DAYS,
  dailyWindows,
  makeContext,
  makeMentee,
  makeMentor,
  shift,
} from "./fixtures.js";

/**
 * The assertions that would run in CI on a real cohort. Four properties, and
 * every one of them is a thing a program admin would notice within a week:
 *
 *   1. zero hard-constraint violations, ever
 *   2. coverage — nobody is unmatched while capacity exists
 *   3. load balance — no mentor quietly absorbs the cohort
 *   4. rank stability — a trivial input change does not re-match everyone
 */

const SKILLS = ["system design", "public speaking", "hiring", "data modelling"];

function cohort(over: { mentorCapacity?: number; mentorCount?: number; menteeCount?: number } = {}) {
  const mentorCount = over.mentorCount ?? 5;
  const menteeCount = over.menteeCount ?? 12;
  const mentors = Array.from({ length: mentorCount }, (_, i) =>
    makeMentor({
      participantId: `mentor_${i}`,
      level: 6 + (i % 3),
      capacity: over.mentorCapacity ?? 3,
      strengths: [
        { name: SKILLS[i % SKILLS.length]!, level: 5 },
        { name: SKILLS[(i + 1) % SKILLS.length]!, level: 4 },
      ],
      availability: dailyWindows(8 + (i % 3), 5),
    }),
  );
  const mentees = Array.from({ length: menteeCount }, (_, i) =>
    makeMentee({
      participantId: `mentee_${i}`,
      level: 3 + (i % 3),
      goals: [{ name: SKILLS[i % SKILLS.length]!, currentLevel: 2, priority: 1 }],
      availability: dailyWindows(9 + (i % 2), 5),
    }),
  );
  return makeContext({ mentors, mentees });
}

/** Re-checks every assignment against the constraints, from scratch. */
function violationsIn(ctx: MatchingContext, output: MatchingOutput): string[] {
  const mentorById = new Map(ctx.mentors.map((m) => [m.participantId, m]));
  const menteeById = new Map(ctx.mentees.map((m) => [m.participantId, m]));
  return output.assignments.flatMap((assignment) => {
    const outcome = checkConstraints({
      mentee: menteeById.get(assignment.menteeId)!,
      mentor: mentorById.get(assignment.mentorId)!,
      ctx: { policy: ctx.policy, horizonDays: HORIZON_DAYS },
    });
    return outcome.violatedBy.map((name) => `${assignment.menteeId}/${assignment.mentorId}:${name}`);
  });
}

const loadOf = (output: MatchingOutput): Map<string, number> => {
  const load = new Map<string, number>();
  for (const a of output.assignments) load.set(a.mentorId, (load.get(a.mentorId) ?? 0) + 1);
  return load;
};

describe("CI assertion: zero hard-constraint violations", () => {
  it("never assigns a pair that a constraint rejected", () => {
    const ctx = cohort();
    expect(violationsIn(ctx, runDeterministicPipeline(ctx))).toEqual([]);
  });

  it("holds under a hostile roster of opt-outs, shared managers and repeats", () => {
    const ctx = makeContext({
      mentors: Array.from({ length: 4 }, (_, i) =>
        makeMentor({
          participantId: `mentor_${i}`,
          capacity: 3,
          managerRef: i < 2 ? "boss_a" : "boss_b",
          optOutParticipantIds: i === 0 ? ["mentee_3"] : [],
        }),
      ),
      mentees: Array.from({ length: 8 }, (_, i) =>
        makeMentee({
          participantId: `mentee_${i}`,
          managerRef: i % 2 === 0 ? "boss_a" : "boss_b",
          priorMentorIds: i < 3 ? ["mentor_2"] : [],
          optOutParticipantIds: i === 5 ? ["mentor_3"] : [],
        }),
      ),
    });
    const output = runDeterministicPipeline(ctx);
    expect(violationsIn(ctx, output)).toEqual([]);
    // And the run still did useful work rather than refusing everything.
    expect(output.assignments.length).toBeGreaterThan(0);
  });

  it("never exceeds remaining capacity, counting prior load", () => {
    const ctx = makeContext({
      mentors: [
        makeMentor({ participantId: "mentor_0", capacity: 3, currentLoad: 2 }),
        makeMentor({ participantId: "mentor_1", capacity: 2, currentLoad: 0 }),
      ],
      mentees: Array.from({ length: 6 }, (_, i) => makeMentee({ participantId: `mentee_${i}` })),
    });
    const output = runDeterministicPipeline(ctx);
    const load = loadOf(output);
    for (const mentor of ctx.mentors) {
      expect(load.get(mentor.participantId) ?? 0).toBeLessThanOrEqual(remainingCapacity(mentor));
    }
    expect(output.assignments).toHaveLength(3);
  });
});

describe("CI assertion: coverage", () => {
  it("leaves nobody unmatched while capacity and an eligible mentor exist", () => {
    const ctx = cohort({ mentorCount: 5, menteeCount: 12, mentorCapacity: 3 });
    const output = runDeterministicPipeline(ctx);
    expect(output.unmatched).toEqual([]);
    expect(output.assignments).toHaveLength(12);
  });

  it("beats greedy on the same cohort when capacity is tight", () => {
    // The same pool, solved two ways. Greedy is not a different opinion about
    // quality; it is a different number of people with a mentor.
    const ctx = makeContext({
      mentors: [
        makeMentor({
          participantId: "mentor_scarce",
          capacity: 1,
          strengths: [{ name: "hiring", level: 5 }],
        }),
        makeMentor({
          participantId: "mentor_spare",
          capacity: 1,
          strengths: [{ name: "system design", level: 5 }],
        }),
      ],
      mentees: [
        // The scarce mentor is this one's ONLY option — a decent fit, not the
        // best one anybody has.
        makeMentee({
          participantId: "mentee_narrow",
          goals: [{ name: "hiring", currentLevel: 4, priority: 1 }],
          optOutParticipantIds: ["mentor_spare"],
        }),
        // Scores higher with the scarce mentor than anyone, and has somewhere
        // else to go. Greedy cannot see the second half of that sentence.
        makeMentee({
          participantId: "mentee_flexible",
          goals: [{ name: "hiring", currentLevel: 1, priority: 1 }],
          preferredParticipantIds: ["mentor_scarce"],
        }),
      ],
    });

    const optimal = runDeterministicPipeline(ctx);
    const greedy = runDeterministicPipeline(ctx, { solver: greedyAssignmentSolver });
    expect(optimal.unmatched).toEqual([]);
    expect(greedy.unmatched).toHaveLength(1);
  });

  it("distinguishes 'no eligible mentor' from 'capacity exhausted'", () => {
    // The two need different actions: relax a rule, or recruit a mentor.
    const ctx = makeContext({
      mentors: [makeMentor({ participantId: "mentor_0", capacity: 1 })],
      mentees: [
        makeMentee({ participantId: "mentee_ok" }),
        makeMentee({ participantId: "mentee_queued" }),
        makeMentee({
          participantId: "mentee_blocked",
          availability: dailyWindows(20, 2),
        }),
      ],
    });
    const output = runDeterministicPipeline(ctx);
    const byMentee = new Map(output.unmatched.map((u) => [u.menteeId, u]));
    expect(byMentee.get("mentee_blocked")?.reason).toBe("no_eligible_mentor");
    expect(byMentee.get("mentee_blocked")?.blockedBy).toMatchObject({ timezone_overlap: 1 });
    expect(byMentee.get("mentee_queued")?.reason).toBe("capacity_exhausted");
  });
});

describe("CI assertion: load balance", () => {
  it("spreads a cohort across interchangeable mentors", () => {
    const ctx = makeContext({
      mentors: Array.from({ length: 3 }, (_, i) =>
        makeMentor({ participantId: `mentor_${i}`, capacity: 4 }),
      ),
      mentees: Array.from({ length: 6 }, (_, i) => makeMentee({ participantId: `mentee_${i}` })),
    });
    const load = loadOf(runDeterministicPipeline(ctx));
    expect([...load.values()].sort()).toEqual([2, 2, 2]);
  });

  it("reports per-mentor load including what they already carried", () => {
    const ctx = makeContext({
      mentors: [makeMentor({ participantId: "mentor_0", capacity: 4, currentLoad: 1 })],
      mentees: [makeMentee({ participantId: "mentee_0" })],
    });
    expect(runDeterministicPipeline(ctx).mentorLoad).toEqual([
      { mentorId: "mentor_0", assigned: 1, priorLoad: 1, capacity: 4 },
    ]);
  });
});

describe("CI assertion: rank stability under perturbation", () => {
  it("does not re-match the cohort because a calendar moved by a minute", () => {
    const base = cohort();
    const nudged = makeContext({
      mentors: base.mentors.map((m) => ({ ...m, availability: shift(m.availability, 1) })),
      mentees: base.mentees,
    });
    const pairs = (output: MatchingOutput): string[] =>
      output.assignments.map((a) => `${a.menteeId}->${a.mentorId}`).sort();
    expect(pairs(runDeterministicPipeline(nudged))).toEqual(pairs(runDeterministicPipeline(base)));
  });

  it("keeps each mentee's top three candidates in the same order", () => {
    const base = cohort();
    const nudged = makeContext({
      mentors: base.mentors.map((m) => ({ ...m, availability: shift(m.availability, 1) })),
      mentees: base.mentees,
    });
    const topThree = (output: MatchingOutput, menteeId: string): string[] =>
      output.candidates
        .filter((c) => c.menteeId === menteeId && c.rank > 0 && c.rank <= 3)
        .sort((a, b) => a.rank - b.rank)
        .map((c) => c.mentorId);
    for (const mentee of base.mentees) {
      expect(topThree(runDeterministicPipeline(nudged), mentee.participantId)).toEqual(
        topThree(runDeterministicPipeline(base), mentee.participantId),
      );
    }
  });

  it("is reproducible: the same pool twice gives the same output", () => {
    const ctx = cohort();
    expect(runDeterministicPipeline(ctx)).toEqual(runDeterministicPipeline(ctx));
  });
});

describe("the persisted record", () => {
  it("keeps every considered pair, winners and losers, with its feature vector", () => {
    const ctx = cohort({ mentorCount: 3, menteeCount: 4 });
    const output = runDeterministicPipeline(ctx);
    expect(output.candidates).toHaveLength(12);
    for (const candidate of output.candidates) {
      expect(Object.keys(candidate.features).length).toBeGreaterThan(0);
      expect(candidate.explanations.skill_fit_directional).toBeTruthy();
    }
  });

  it("records WHY an ineligible pair was rejected, in words", () => {
    const ctx = makeContext({
      mentors: [makeMentor({ participantId: "mentor_0", managerRef: "boss" })],
      mentees: [makeMentee({ participantId: "mentee_0", managerRef: "boss" })],
    });
    const record = runDeterministicPipeline(ctx).candidates[0]!;
    expect(record.eligible).toBe(false);
    expect(record.violations).toContain("same manager");
    // Scored anyway: "she would have been your best match, but" is the answer
    // an appeal needs, and it cannot be reconstructed after the fact.
    expect(record.deterministicScore).toBeGreaterThan(0);
  });

  it("can skip scoring ineligible pairs when a pool is large enough to care", () => {
    const ctx = makeContext({
      mentors: [makeMentor({ participantId: "mentor_0", managerRef: "boss" })],
      mentees: [makeMentee({ participantId: "mentee_0", managerRef: "boss" })],
    });
    const record = runDeterministicPipeline(ctx, { scoreIneligible: false }).candidates[0]!;
    expect(record.features).toEqual({});
  });

  it("ranks only eligible candidates, leaving the rest at rank 0", () => {
    const ctx = makeContext({
      mentors: [
        makeMentor({ participantId: "mentor_ok" }),
        makeMentor({ participantId: "mentor_blocked", optOutParticipantIds: ["mentee_0"] }),
      ],
      mentees: [makeMentee({ participantId: "mentee_0" })],
    });
    const output = runDeterministicPipeline(ctx);
    const byMentor = new Map(output.candidates.map((c) => [c.mentorId, c]));
    expect(byMentor.get("mentor_ok")?.rank).toBe(1);
    expect(byMentor.get("mentor_blocked")?.rank).toBe(0);
  });

  it("marks the shortlist the model would have been shown", () => {
    const ctx = cohort({ mentorCount: 5, menteeCount: 2 });
    const output = runDeterministicPipeline(ctx, {});
    const shortlisted = output.candidates.filter(
      (c) => c.menteeId === "mentee_0" && c.shortlisted,
    );
    // Five eligible mentors, shortlist size eight: all of them.
    expect(shortlisted.length).toBe(
      shortlistFor(evaluatePool(ctx), "mentee_0", ctx.policy.shortlistSize).length,
    );
  });

  it("caps the shortlist at the policy size, best first", () => {
    const ctx = makeContext({
      mentors: Array.from({ length: 10 }, (_, i) =>
        makeMentor({ participantId: `mentor_${i}`, level: 5 + (i % 4) }),
      ),
      mentees: [makeMentee({ participantId: "mentee_0" })],
      matching: { shortlistSize: 3 },
    });
    const shortlist = shortlistFor(evaluatePool(ctx), "mentee_0", 3);
    expect(shortlist).toHaveLength(3);
    expect(shortlist[0]!.deterministicScore).toBeGreaterThanOrEqual(
      shortlist[2]!.deterministicScore,
    );
  });

  it("validates against the output schema, so it is safe to persist", () => {
    const output = runDeterministicPipeline(cohort());
    expect(() => MatchingOutputSchema.parse(output)).not.toThrow();
    expect(output.adjudicated).toBe(false);
    expect(output.solver).toBe("min_cost_flow");
  });
});
