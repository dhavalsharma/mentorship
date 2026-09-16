import { describe, expect, it } from "vitest";
import {
  availabilityOverlap,
  defaultMatchingPolicy,
  levelGapBand,
  overlapHoursPerFortnight,
  programFairness,
  registerScorer,
  scoreCandidate,
  skillFitDirectional,
  statedPreference,
  DEFAULT_FEATURE_SCORERS,
  type FeatureScorer,
  type ScoringContext,
} from "@mentorship/primitive-matching";
import { HORIZON_DAYS, dailyWindows, makeMentee, makeMentor } from "./fixtures.js";

const ctx = (over: Parameters<typeof defaultMatchingPolicy>[0] = {}): ScoringContext => ({
  policy: defaultMatchingPolicy(over),
  horizonDays: HORIZON_DAYS,
});

describe("skill fit is directional, not symmetric", () => {
  it("scores a mentor who is ahead on the mentee's goal", () => {
    const value = skillFitDirectional.score({
      mentee: makeMentee({
        participantId: "mentee_1",
        goals: [{ name: "system design", currentLevel: 2, priority: 1 }],
      }),
      mentor: makeMentor({
        participantId: "mentor_1",
        strengths: [{ name: "system design", level: 4 }],
      }),
      ctx: ctx(),
    });
    expect(value.value).toBe(1);
  });

  it("scores a PEER at zero, however perfect the symmetric overlap", () => {
    // The failure this feature exists to prevent: two people who both list the
    // same three skills at the same level have a flawless similarity score and
    // nothing to teach each other.
    const identicalSkills = [
      { name: "system design", level: 3 },
      { name: "public speaking", level: 3 },
    ];
    const peer = skillFitDirectional.score({
      mentee: makeMentee({
        participantId: "mentee_1",
        goals: identicalSkills.map((s) => ({
          name: s.name,
          currentLevel: s.level,
          priority: 1,
        })),
      }),
      mentor: makeMentor({ participantId: "mentor_1", strengths: identicalSkills }),
      ctx: ctx(),
    });
    expect(peer.value).toBe(0);
    expect(peer.explain).toMatch(/not ahead/);
  });

  it("ranks the mentor who is ahead above the identically-skilled peer", () => {
    const mentee = makeMentee({
      participantId: "mentee_1",
      goals: [{ name: "system design", currentLevel: 3, priority: 1 }],
    });
    const peer = skillFitDirectional.score({
      mentee,
      mentor: makeMentor({
        participantId: "peer",
        strengths: [{ name: "system design", level: 3 }],
      }),
      ctx: ctx(),
    });
    const ahead = skillFitDirectional.score({
      mentee,
      mentor: makeMentor({
        participantId: "ahead",
        strengths: [{ name: "system design", level: 5 }],
      }),
      ctx: ctx(),
    });
    expect(ahead.value).toBeGreaterThan(peer.value);
  });

  it("weights goals by the priority the mentee gave them", () => {
    const mentee = makeMentee({
      participantId: "mentee_1",
      goals: [
        { name: "system design", currentLevel: 1, priority: 1 },
        { name: "negotiation", currentLevel: 1, priority: 0.25 },
      ],
    });
    const coversMain = skillFitDirectional.score({
      mentee,
      mentor: makeMentor({
        participantId: "a",
        strengths: [{ name: "system design", level: 5 }],
      }),
      ctx: ctx(),
    });
    const coversMinor = skillFitDirectional.score({
      mentee,
      mentor: makeMentor({
        participantId: "b",
        strengths: [{ name: "negotiation", level: 5 }],
      }),
      ctx: ctx(),
    });
    expect(coversMain.value).toBeGreaterThan(coversMinor.value);
    expect(coversMain.value).toBeCloseTo(1 / 1.25, 5);
  });

  it("scores a mentee with no stated goals as unknown, not as a bad match", () => {
    const result = skillFitDirectional.score({
      mentee: makeMentee({ participantId: "mentee_1", goals: [] }),
      mentor: makeMentor({ participantId: "mentor_1" }),
      ctx: ctx(),
    });
    expect(result.value).toBe(0.5);
  });

  it("matches skill names case- and whitespace-insensitively", () => {
    const result = skillFitDirectional.score({
      mentee: makeMentee({
        participantId: "mentee_1",
        goals: [{ name: " System Design ", currentLevel: 1, priority: 1 }],
      }),
      mentor: makeMentor({
        participantId: "mentor_1",
        strengths: [{ name: "system design", level: 4 }],
      }),
      ctx: ctx(),
    });
    expect(result.value).toBe(1);
  });
});

describe("level gap band", () => {
  const gap = (mentorLevel: number, menteeLevel = 4): number =>
    levelGapBand.score({
      mentee: makeMentee({ participantId: "mentee_1", level: menteeLevel }),
      mentor: makeMentor({ participantId: "mentor_1", level: mentorLevel }),
      ctx: ctx(),
    }).value;

  it("rewards one to two levels up", () => {
    expect(gap(5)).toBe(1);
    expect(gap(6)).toBe(1);
  });

  it("penalises a five-level gap", () => {
    expect(gap(9)).toBeLessThan(0.2);
  });

  it("treats too senior as no better than too junior", () => {
    // Symmetric by design: an exec five levels up has no shared context, a
    // peer two levels down has nothing to teach. Both are the wrong match.
    expect(gap(9)).toBeCloseTo(gap(2), 10);
  });

  it("never returns a negative score, however wide the gap", () => {
    expect(gap(12, 1)).toBeGreaterThan(0);
  });
});

describe("availability overlap", () => {
  it("counts mutual UTC hours, normalised per fortnight", () => {
    const hours = overlapHoursPerFortnight(dailyWindows(9, 4), dailyWindows(11, 4), 14);
    // 2h of overlap on each of 10 days, over a 14-day horizon.
    expect(hours).toBeCloseTo(20, 6);
  });

  it("is independent of how long a horizon the pool was built over", () => {
    // Widening the horizon must not re-rank the cohort by inflating everyone's
    // raw overlap hours.
    const fortnight = overlapHoursPerFortnight(dailyWindows(9, 4, 10), dailyWindows(9, 4, 10), 14);
    const month = overlapHoursPerFortnight(dailyWindows(9, 4, 20), dailyWindows(9, 4, 20), 28);
    expect(month).toBeCloseTo(fortnight, 6);
  });

  it("saturates at the policy target rather than rewarding infinite overlap", () => {
    const result = availabilityOverlap.score({
      mentee: makeMentee({ participantId: "mentee_1", availability: dailyWindows(9, 8) }),
      mentor: makeMentor({ participantId: "mentor_1", availability: dailyWindows(9, 8) }),
      ctx: ctx(),
    });
    expect(result.value).toBe(1);
  });

  it("scores disjoint calendars at zero", () => {
    const result = availabilityOverlap.score({
      mentee: makeMentee({ participantId: "mentee_1", availability: dailyWindows(2, 2) }),
      mentor: makeMentor({ participantId: "mentor_1", availability: dailyWindows(20, 2) }),
      ctx: ctx(),
    });
    expect(result.value).toBe(0);
  });
});

describe("stated preference and fairness", () => {
  it("lifts a mutual request above a one-sided one above neutral", () => {
    const mutual = statedPreference.score({
      mentee: makeMentee({ participantId: "mentee_1", preferredParticipantIds: ["mentor_1"] }),
      mentor: makeMentor({ participantId: "mentor_1", preferredParticipantIds: ["mentee_1"] }),
      ctx: ctx(),
    }).value;
    const oneSided = statedPreference.score({
      mentee: makeMentee({ participantId: "mentee_1", preferredParticipantIds: ["mentor_1"] }),
      mentor: makeMentor({ participantId: "mentor_1" }),
      ctx: ctx(),
    }).value;
    const neutral = statedPreference.score({
      mentee: makeMentee({ participantId: "mentee_1" }),
      mentor: makeMentor({ participantId: "mentor_1" }),
      ctx: ctx(),
    }).value;
    expect(mutual).toBeGreaterThan(oneSided);
    expect(oneSided).toBeGreaterThan(neutral);
    // Neutral is mid-scale, not zero: nobody objected.
    expect(neutral).toBe(0.5);
  });

  it("prefers the mentor with more headroom", () => {
    const empty = programFairness.score({
      mentee: makeMentee({ participantId: "mentee_1" }),
      mentor: makeMentor({ participantId: "a", capacity: 4, currentLoad: 0 }),
      ctx: ctx(),
    }).value;
    const nearlyFull = programFairness.score({
      mentee: makeMentee({ participantId: "mentee_1" }),
      mentor: makeMentor({ participantId: "b", capacity: 4, currentLoad: 3 }),
      ctx: ctx(),
    }).value;
    expect(empty).toBeGreaterThan(nearlyFull);
  });

  it("applies fairness flag weights configured by the program", () => {
    const withFlag = programFairness.score({
      mentee: makeMentee({ participantId: "mentee_1", fairnessFlags: ["cohort_priority"] }),
      mentor: makeMentor({ participantId: "a", capacity: 4, currentLoad: 2 }),
      ctx: ctx({ fairnessFlagWeights: { cohort_priority: 1 } }),
    }).value;
    const withoutFlag = programFairness.score({
      mentee: makeMentee({ participantId: "mentee_1" }),
      mentor: makeMentor({ participantId: "a", capacity: 4, currentLoad: 2 }),
      ctx: ctx({ fairnessFlagWeights: { cohort_priority: 1 } }),
    }).value;
    expect(withFlag).toBeGreaterThan(withoutFlag);
  });
});

describe("the weighted composite", () => {
  const input = {
    mentee: makeMentee({ participantId: "mentee_1" }),
    mentor: makeMentor({ participantId: "mentor_1" }),
  };

  it("records every feature, including ones carrying no weight", () => {
    // How you measure a candidate feature before trusting it with weight.
    const scored = scoreCandidate({
      ...input,
      ctx: ctx({ weights: { skill_fit_directional: 1 } }),
    });
    expect(Object.keys(scored.features).sort()).toEqual(
      DEFAULT_FEATURE_SCORERS.map((s) => s.name).sort(),
    );
    expect(scored.score).toBe(scored.features.skill_fit_directional);
  });

  it("shifts with the weights, which come from policy and not from code", () => {
    const skillHeavy = scoreCandidate({
      ...input,
      ctx: ctx({ weights: { skill_fit_directional: 1, stated_preference: 0 } }),
    }).score;
    const preferenceHeavy = scoreCandidate({
      ...input,
      ctx: ctx({ weights: { skill_fit_directional: 0, stated_preference: 1 } }),
    }).score;
    expect(skillHeavy).not.toBe(preferenceHeavy);
  });

  it("carries a human-readable explanation per feature", () => {
    const scored = scoreCandidate({ ...input, ctx: ctx() });
    for (const scorer of DEFAULT_FEATURE_SCORERS) {
      expect(scored.explanations[scorer.name]).toBeTruthy();
    }
  });

  it("accepts a registered scorer, replacing one of the same name", () => {
    const stub: FeatureScorer = {
      name: "availability_overlap",
      score: () => ({ value: 0.123, explain: "stubbed" }),
    };
    const scorers = registerScorer(DEFAULT_FEATURE_SCORERS, stub);
    expect(scorers).toHaveLength(DEFAULT_FEATURE_SCORERS.length);
    const scored = scoreCandidate({ ...input, ctx: ctx() }, scorers);
    expect(scored.features.availability_overlap).toBe(0.123);
  });

  it("returns zero rather than NaN when every weight is zero", () => {
    const scored = scoreCandidate({ ...input, ctx: ctx({ weights: {} }) });
    expect(scored.score).toBe(0);
  });
});
