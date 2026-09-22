import { describe, expect, it } from "vitest";
import {
  checkConstraints,
  greedyAssignmentSolver,
  runDeterministicPipeline,
  type MatchingContext,
  type MatchingOutput,
} from "@mentorship/primitive-matching";
import { HORIZON_DAYS, dailyWindows, lcg, makeContext, makeMentee, makeMentor } from "./fixtures.js";

/**
 * Named, standalone CI gate for matching's two constraint-satisfaction and
 * coverage properties — the ROADMAP item that used to be "covered
 * incidentally by `pipeline.test.ts`". `pipeline.test.ts` still asserts
 * these against hand-built fixtures; this file asserts the same two
 * properties across a *population* of randomized cohorts, generated from a
 * seeded PRNG so a failure is reproducible (the seed is logged in the
 * assertion message).
 *
 * There is no CI workflow file in this repo yet (CLAUDE.md invariant 2's
 * note), so "wired into CI" means exactly one thing here: this suite runs
 * as part of the default `pnpm test`, with no DATABASE_URL and no model —
 * same as every other test in this package.
 */

const SKILLS = ["system design", "public speaking", "hiring", "data modelling", "coaching"];
const RANDOM_COHORTS = 40;

interface RandomCohort {
  seed: number;
  ctx: MatchingContext;
}

/** One randomized cohort per seed — capacities, availability, opt-outs, shared managers, prior pairings, all varied. */
function randomCohort(seed: number): RandomCohort {
  const rand = lcg(seed);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T,>(items: T[]) => items[int(0, items.length - 1)]!;

  const mentorCount = int(2, 6);
  const menteeCount = int(4, 15);
  const managerGroups = ["boss_a", "boss_b", "boss_c"];

  const mentors = Array.from({ length: mentorCount }, (_, i) =>
    makeMentor({
      participantId: `mentor_${i}`,
      level: int(5, 11),
      capacity: int(0, 3),
      currentLoad: int(0, 1),
      managerRef: rand() < 0.3 ? pick(managerGroups) : null,
      strengths: [
        { name: pick(SKILLS), level: int(3, 5) },
        { name: pick(SKILLS), level: int(2, 5) },
      ],
      availability: dailyWindows(int(6, 14), int(2, 8)),
      optOutParticipantIds: [],
    }),
  );

  const mentees = Array.from({ length: menteeCount }, (_, i) => {
    const optOut =
      rand() < 0.15 && mentors.length > 0 ? [pick(mentors).participantId] : [];
    const priorMentor =
      rand() < 0.15 && mentors.length > 0 ? [pick(mentors).participantId] : [];
    return makeMentee({
      participantId: `mentee_${i}`,
      level: int(1, 8),
      managerRef: rand() < 0.3 ? pick(managerGroups) : null,
      goals: [{ name: pick(SKILLS), currentLevel: int(1, 3), priority: rand() }],
      availability: dailyWindows(int(6, 14), int(2, 8)),
      optOutParticipantIds: optOut,
      priorMentorIds: priorMentor,
    });
  });

  return { seed, ctx: makeContext({ mentors, mentees }) };
}

/** Every assignment, re-checked from scratch against the hard constraints. */
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

describe("matching invariants (randomized, named CI gate)", () => {
  it("never commits an assignment that violates a hard constraint, across randomized cohorts", () => {
    for (let seed = 0; seed < RANDOM_COHORTS; seed++) {
      const { ctx } = randomCohort(seed);
      const output = runDeterministicPipeline(ctx);
      const violations = violationsIn(ctx, output);
      expect(violations, `seed ${seed} produced a constraint-violating assignment`).toEqual([]);
    }
  });

  it("never assigns capacity beyond what a mentor has remaining, across randomized cohorts", () => {
    for (let seed = 0; seed < RANDOM_COHORTS; seed++) {
      const { ctx } = randomCohort(seed);
      const output = runDeterministicPipeline(ctx);
      const load = new Map<string, number>();
      for (const a of output.assignments) load.set(a.mentorId, (load.get(a.mentorId) ?? 0) + 1);
      for (const mentor of ctx.mentors) {
        const remaining = Math.max(0, mentor.capacity - mentor.currentLoad);
        expect(
          load.get(mentor.participantId) ?? 0,
          `seed ${seed}, mentor ${mentor.participantId} over capacity`,
        ).toBeLessThanOrEqual(remaining);
      }
    }
  });

  it("matches at least as many mentees as a naive greedy baseline, across randomized cohorts", () => {
    for (let seed = 0; seed < RANDOM_COHORTS; seed++) {
      const { ctx } = randomCohort(seed);
      const solved = runDeterministicPipeline(ctx);
      const greedy = runDeterministicPipeline(ctx, { solver: greedyAssignmentSolver });
      expect(
        solved.assignments.length,
        `seed ${seed}: solver matched fewer than greedy`,
      ).toBeGreaterThanOrEqual(greedy.assignments.length);
    }
  });

  it("is reproducible: the same seed's cohort produces the same output twice", () => {
    for (let seed = 0; seed < 5; seed++) {
      const { ctx } = randomCohort(seed);
      expect(runDeterministicPipeline(ctx)).toEqual(runDeterministicPipeline(ctx));
    }
  });
});
