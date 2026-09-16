import { describe, expect, it } from "vitest";
import {
  greedyAssignmentSolver,
  minCostFlowSolver,
  type AssignmentRequest,
  type CandidateEdge,
} from "@mentorship/primitive-matching";
import { lcg } from "./fixtures.js";

/**
 * The solver is where the difference between "a ranking" and "a matching"
 * lives. Every test here is really one assertion: coverage is not something
 * you hope for after sorting by score.
 */

const request = (over: Partial<AssignmentRequest> = {}): AssignmentRequest => ({
  menteeIds: [],
  mentors: [],
  edges: [],
  loadBalancePenalty: 0,
  ...over,
});

const loadOf = (result: { assignments: { mentorId: string }[] }): Record<string, number> => {
  const load: Record<string, number> = {};
  for (const a of result.assignments) load[a.mentorId] = (load[a.mentorId] ?? 0) + 1;
  return load;
};

describe("min-cost flow versus greedy", () => {
  /**
   * The canonical trap, and the reason this package contains a flow algorithm
   * instead of a sort.
   *
   * mentee_b scores best with the only mentor mentee_a can be paired with.
   * Greedy takes the highest-scoring edge first, spends mentor_x's only slot on
   * mentee_b, and strands mentee_a — while mentor_y sits under capacity.
   */
  const trap = request({
    menteeIds: ["mentee_a", "mentee_b"],
    mentors: [
      { mentorId: "mentor_x", capacity: 1 },
      { mentorId: "mentor_y", capacity: 1 },
    ],
    edges: [
      { menteeId: "mentee_a", mentorId: "mentor_x", score: 0.6 },
      { menteeId: "mentee_b", mentorId: "mentor_x", score: 0.95 },
      { menteeId: "mentee_b", mentorId: "mentor_y", score: 0.9 },
    ],
  });

  it("greedy strands a mentee while capacity is still free", () => {
    const greedy = greedyAssignmentSolver.solve(trap);
    expect(greedy.unmatchedMenteeIds).toEqual(["mentee_a"]);
    expect(loadOf(greedy).mentor_y).toBeUndefined();
  });

  it("the flow solver matches everyone on the same input", () => {
    const flow = minCostFlowSolver.solve(trap);
    expect(flow.unmatchedMenteeIds).toEqual([]);
    expect(flow.assignments).toEqual(
      expect.arrayContaining([
        { menteeId: "mentee_a", mentorId: "mentor_x", score: 0.6 },
        { menteeId: "mentee_b", mentorId: "mentor_y", score: 0.9 },
      ]),
    );
  });

  it("sacrifices a little quality for coverage, knowingly", () => {
    // Greedy's total is higher per assignment. It is also one mentee short,
    // which is the trade nobody would make if they saw it stated.
    const flow = minCostFlowSolver.solve(trap);
    const greedy = greedyAssignmentSolver.solve(trap);
    expect(flow.assignments.length).toBeGreaterThan(greedy.assignments.length);
    expect(flow.totalScore).toBeGreaterThan(greedy.totalScore);
  });
});

describe("capacity", () => {
  it("never exceeds a mentor's remaining capacity", () => {
    const result = minCostFlowSolver.solve(
      request({
        menteeIds: ["m1", "m2", "m3", "m4"],
        mentors: [{ mentorId: "only", capacity: 2 }],
        edges: ["m1", "m2", "m3", "m4"].map((menteeId) => ({
          menteeId,
          mentorId: "only",
          score: 0.8,
        })),
      }),
    );
    expect(result.assignments).toHaveLength(2);
    expect(result.unmatchedMenteeIds).toHaveLength(2);
  });

  it("is a b-matching: one mentor can take several mentees", () => {
    const result = minCostFlowSolver.solve(
      request({
        menteeIds: ["m1", "m2", "m3"],
        mentors: [{ mentorId: "deep", capacity: 3 }],
        edges: ["m1", "m2", "m3"].map((menteeId) => ({
          menteeId,
          mentorId: "deep",
          score: 0.7,
        })),
      }),
    );
    expect(loadOf(result)).toEqual({ deep: 3 });
  });

  it("ignores a mentor with zero capacity rather than assigning to them", () => {
    const result = minCostFlowSolver.solve(
      request({
        menteeIds: ["m1"],
        mentors: [{ mentorId: "full", capacity: 0 }],
        edges: [{ menteeId: "m1", mentorId: "full", score: 1 }],
      }),
    );
    expect(result.assignments).toHaveLength(0);
    expect(result.unmatchedMenteeIds).toEqual(["m1"]);
  });

  it("leaves a mentee with no eligible edge unmatched, without throwing", () => {
    const result = minCostFlowSolver.solve(
      request({
        menteeIds: ["lonely"],
        mentors: [{ mentorId: "someone", capacity: 5 }],
        edges: [],
      }),
    );
    expect(result.unmatchedMenteeIds).toEqual(["lonely"]);
  });
});

describe("load balance", () => {
  const balanced = request({
    menteeIds: ["m1", "m2", "m3", "m4", "m5", "m6"],
    mentors: [
      { mentorId: "a", capacity: 3 },
      { mentorId: "b", capacity: 3 },
      { mentorId: "c", capacity: 3 },
    ],
    edges: ["m1", "m2", "m3", "m4", "m5", "m6"].flatMap((menteeId) =>
      ["a", "b", "c"].map((mentorId) => ({ menteeId, mentorId, score: 0.8 })),
    ),
  });

  it("spreads equal-scoring mentees evenly when a penalty is configured", () => {
    const result = minCostFlowSolver.solve({ ...balanced, loadBalancePenalty: 0.02 });
    expect(Object.values(loadOf(result)).sort()).toEqual([2, 2, 2]);
  });

  it("still fills a mentor when the alternative is materially worse", () => {
    // The penalty breaks ties; it does not override a real quality difference.
    const result = minCostFlowSolver.solve({
      ...balanced,
      loadBalancePenalty: 0.02,
      edges: balanced.edges.map((e) => ({
        ...e,
        score: e.mentorId === "a" ? 0.95 : 0.2,
      })),
    });
    expect(loadOf(result).a).toBe(3);
  });
});

describe("optimality and determinism", () => {
  const instance = (seed: number): AssignmentRequest => {
    const random = lcg(seed);
    const menteeIds = Array.from({ length: 12 }, (_, i) => `mentee_${i}`);
    const mentors = Array.from({ length: 5 }, (_, i) => ({
      mentorId: `mentor_${i}`,
      capacity: 1 + Math.floor(random() * 3),
    }));
    const edges: CandidateEdge[] = [];
    for (const menteeId of menteeIds) {
      for (const mentor of mentors) {
        // A sparse graph: sparsity is exactly when greedy strands people.
        if (random() < 0.45) {
          edges.push({
            menteeId,
            mentorId: mentor.mentorId,
            score: Math.round(random() * 1e4) / 1e4,
          });
        }
      }
    }
    return { menteeIds, mentors, edges, loadBalancePenalty: 0 };
  };

  it("matches at least as many mentees as greedy, on every instance", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const input = instance(seed);
      const flow = minCostFlowSolver.solve(input);
      const greedy = greedyAssignmentSolver.solve(input);
      expect(flow.assignments.length).toBeGreaterThanOrEqual(greedy.assignments.length);
    }
  });

  it("strictly beats greedy on coverage somewhere in the sample", () => {
    // If this ever stops being true the instances got too dense to be
    // interesting, not that greedy became correct.
    const wins = Array.from({ length: 40 }, (_, i) => instance(i + 1)).filter(
      (input) =>
        minCostFlowSolver.solve(input).assignments.length >
        greedyAssignmentSolver.solve(input).assignments.length,
    );
    expect(wins.length).toBeGreaterThan(0);
  });

  it("never scores worse than greedy at equal coverage", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const input = instance(seed);
      const flow = minCostFlowSolver.solve(input);
      const greedy = greedyAssignmentSolver.solve(input);
      if (flow.assignments.length === greedy.assignments.length) {
        expect(flow.totalScore).toBeGreaterThanOrEqual(greedy.totalScore - 1e-9);
      }
    }
  });

  it("respects capacity on every generated instance", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const input = instance(seed);
      const load = loadOf(minCostFlowSolver.solve(input));
      for (const mentor of input.mentors) {
        expect(load[mentor.mentorId] ?? 0).toBeLessThanOrEqual(mentor.capacity);
      }
    }
  });

  it("returns the same matching regardless of the order edges were assembled", () => {
    // Otherwise a query with no ORDER BY re-matches the cohort every run.
    const input = instance(7);
    const shuffled = {
      ...input,
      edges: [...input.edges].reverse(),
      mentors: [...input.mentors].reverse(),
      menteeIds: [...input.menteeIds].reverse(),
    };
    const a = minCostFlowSolver.solve(input);
    const b = minCostFlowSolver.solve(shuffled);
    const norm = (r: typeof a): string[] =>
      r.assignments.map((x) => `${x.menteeId}->${x.mentorId}`).sort();
    expect(norm(b)).toEqual(norm(a));
  });

  it("is reproducible across repeated calls", () => {
    const input = instance(11);
    expect(minCostFlowSolver.solve(input)).toEqual(minCostFlowSolver.solve(input));
  });
});
