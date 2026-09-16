import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARD_CONSTRAINTS,
  checkConstraints,
  defaultMatchingPolicy,
  type ScoringContext,
} from "@mentorship/primitive-matching";
import { HORIZON_DAYS, dailyWindows, makeMentee, makeMentor } from "./fixtures.js";

/**
 * Hard constraints are the promise that nothing downstream can overturn. A
 * violated constraint that a high score can outvote is not a constraint, it is
 * a preference with a stern name.
 */

const ctx = (over: Parameters<typeof defaultMatchingPolicy>[0] = {}): ScoringContext => ({
  policy: defaultMatchingPolicy(over),
  horizonDays: HORIZON_DAYS,
});

describe("hard constraints", () => {
  it("rejects a mentor with no remaining capacity", () => {
    const outcome = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1" }),
      mentor: makeMentor({ participantId: "mentor_1", capacity: 2, currentLoad: 2 }),
      ctx: ctx(),
    });
    expect(outcome.eligible).toBe(false);
    expect(outcome.violatedBy).toContain("mentor_capacity");
    expect(outcome.reasons.join(" ")).toMatch(/at capacity \(2\/2\)/);
  });

  it("allows a mentor with partial load", () => {
    const outcome = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1" }),
      mentor: makeMentor({ participantId: "mentor_1", capacity: 3, currentLoad: 2 }),
      ctx: ctx(),
    });
    expect(outcome.eligible).toBe(true);
  });

  it("honours an opt-out from either side", () => {
    const fromMentee = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1", optOutParticipantIds: ["mentor_1"] }),
      mentor: makeMentor({ participantId: "mentor_1" }),
      ctx: ctx(),
    });
    const fromMentor = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1" }),
      mentor: makeMentor({ participantId: "mentor_1", optOutParticipantIds: ["mentee_1"] }),
      ctx: ctx(),
    });
    expect(fromMentee.eligible).toBe(false);
    expect(fromMentor.eligible).toBe(false);
  });

  it("excludes a shared manager, and the mentor who IS the manager", () => {
    const shared = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1", managerRef: "boss_1" }),
      mentor: makeMentor({ participantId: "mentor_1", managerRef: "boss_1" }),
      ctx: ctx(),
    });
    const direct = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1", managerRef: "mentor_1" }),
      mentor: makeMentor({ participantId: "mentor_1", managerRef: "boss_2" }),
      ctx: ctx(),
    });
    expect(shared.violatedBy).toContain("same_manager");
    expect(direct.reasons).toContain("mentor is the mentee's manager");
  });

  it("does not treat two unknown managers as the same manager", () => {
    const outcome = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1", managerRef: null }),
      mentor: makeMentor({ participantId: "mentor_1", managerRef: null }),
      ctx: ctx(),
    });
    expect(outcome.eligible).toBe(true);
  });

  it("lets a program turn the same-manager rule off, as data", () => {
    const outcome = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1", managerRef: "boss_1" }),
      mentor: makeMentor({ participantId: "mentor_1", managerRef: "boss_1" }),
      ctx: ctx({ excludeSameManager: false }),
    });
    expect(outcome.eligible).toBe(true);
  });

  it("blocks a repeat pairing unless the program allows it", () => {
    const mentee = makeMentee({ participantId: "mentee_1", priorMentorIds: ["mentor_1"] });
    const mentor = makeMentor({ participantId: "mentor_1" });
    expect(checkConstraints({ mentee, mentor, ctx: ctx() }).eligible).toBe(false);
    expect(
      checkConstraints({ mentee, mentor, ctx: ctx({ allowRepeatPairing: true }) }).eligible,
    ).toBe(true);
  });

  it("blocks a pair with no workable mutual time", () => {
    // India morning against California morning: no mutual working hour exists,
    // and proposing 03:00 is worse than saying so.
    const outcome = checkConstraints({
      mentee: makeMentee({ participantId: "mentee_1", availability: dailyWindows(4, 3) }),
      mentor: makeMentor({ participantId: "mentor_1", availability: dailyWindows(17, 3) }),
      ctx: ctx(),
    });
    expect(outcome.eligible).toBe(false);
    expect(outcome.violatedBy).toContain("timezone_overlap");
  });

  it("refuses to pair someone with themselves", () => {
    const outcome = checkConstraints({
      mentee: makeMentee({ participantId: "both_1" }),
      mentor: makeMentor({ participantId: "both_1" }),
      ctx: ctx(),
    });
    expect(outcome.violatedBy).toContain("self");
  });

  it("reports every violation, not just the first", () => {
    // An admin relaxing one rule needs to know the pair is still blocked by
    // another; short-circuiting hides that until the next run.
    const outcome = checkConstraints({
      mentee: makeMentee({
        participantId: "mentee_1",
        managerRef: "boss_1",
        priorMentorIds: ["mentor_1"],
        availability: dailyWindows(4, 2),
      }),
      mentor: makeMentor({
        participantId: "mentor_1",
        managerRef: "boss_1",
        capacity: 1,
        currentLoad: 1,
        availability: dailyWindows(18, 2),
      }),
      ctx: ctx(),
    });
    expect(outcome.violatedBy).toEqual([
      "mentor_capacity",
      "same_manager",
      "prior_pairing",
      "timezone_overlap",
    ]);
    expect(outcome.reasons).toHaveLength(4);
  });

  it("runs a caller-supplied constraint set", () => {
    const noop = checkConstraints(
      {
        mentee: makeMentee({ participantId: "mentee_1", optOutParticipantIds: ["mentor_1"] }),
        mentor: makeMentor({ participantId: "mentor_1" }),
        ctx: ctx(),
      },
      DEFAULT_HARD_CONSTRAINTS.filter((c) => c.name !== "explicit_opt_out"),
    );
    expect(noop.eligible).toBe(true);
  });
});
