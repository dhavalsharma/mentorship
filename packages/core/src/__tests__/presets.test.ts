import { describe, expect, it } from "vitest";
import {
  CORPORATE_CAREER_MENTORING_POLICY,
  FOUNDER_NETWORK_POLICY,
  PROGRAM_POLICY_PRESETS,
  ProgramPolicySchema,
  StoredProgramPolicySchema,
  UNIVERSITY_MENTORING_POLICY,
  resolveCadence,
} from "@mentorship/core";

/**
 * ADR-0001 calls presets "the real test of the claim" that program policy is
 * data, not code. These tests assert each preset is exactly that: valid data
 * that resolvers already in core (cadence resolution) act on differently
 * without any of them branching on which preset it is.
 */
describe("program policy presets", () => {
  for (const [name, policy] of Object.entries(PROGRAM_POLICY_PRESETS)) {
    it(`${name} parses as a fresh ProgramPolicy`, () => {
      expect(() => ProgramPolicySchema.parse(policy)).not.toThrow();
    });

    it(`${name} parses as a StoredProgramPolicy (consent stated explicitly)`, () => {
      // StoredProgramPolicySchema is the strict read-side gate (policy.ts):
      // consent must be present, not defaulted. Every preset states it.
      expect(() => StoredProgramPolicySchema.parse(policy)).not.toThrow();
    });
  }

  it("presets are genuinely distinct, not the same object three times", () => {
    const values = Object.values(PROGRAM_POLICY_PRESETS);
    expect(new Set(values.map((p) => JSON.stringify(p))).size).toBe(values.length);
  });

  describe("university: 1:1, fortnightly, term-bound", () => {
    it("caps mentor capacity at one mentee", () => {
      expect(UNIVERSITY_MENTORING_POLICY.pairing.mentorCapacityDefault).toBe(1);
    });

    it("resolves to a 14-day cadence with no pair override", () => {
      const resolved = resolveCadence(UNIVERSITY_MENTORING_POLICY.cadence);
      expect(resolved.everyDays).toBe(14);
      expect(resolved.label).toBe("fortnightly");
    });

    it("bounds goals to a semester-length structured cycle", () => {
      expect(UNIVERSITY_MENTORING_POLICY.goals).toMatchObject({
        structure: "structured",
        cycleDays: 112,
        requireDueDate: true,
      });
    });

    it("keeps recording off, matching the schema default", () => {
      expect(UNIVERSITY_MENTORING_POLICY.consent.recording).toBe("off");
    });
  });

  describe("corporate career: monthly, quarterly goals tied to review cycle", () => {
    it("resolves to a monthly cadence", () => {
      const resolved = resolveCadence(CORPORATE_CAREER_MENTORING_POLICY.cadence);
      expect(resolved.everyDays).toBe(30);
      expect(resolved.label).toBe("monthly");
    });

    it("ties goals to a 90-day quarter", () => {
      expect(CORPORATE_CAREER_MENTORING_POLICY.goals.cycleDays).toBe(90);
      expect(CORPORATE_CAREER_MENTORING_POLICY.goals.label).toBe("quarter");
    });

    it("allows a mentor more mentees than the university preset (group-leaning cardinality)", () => {
      expect(CORPORATE_CAREER_MENTORING_POLICY.pairing.mentorCapacityDefault).toBeGreaterThan(
        UNIVERSITY_MENTORING_POLICY.pairing.mentorCapacityDefault,
      );
    });

    it("requires AI-processing consent, unlike the other two presets", () => {
      expect(CORPORATE_CAREER_MENTORING_POLICY.consent.aiProcessing).toBe("required");
    });

    it("weights completion and velocity above cadence adherence, for a review-cycle program", () => {
      const w = CORPORATE_CAREER_MENTORING_POLICY.healthWeights;
      expect(w.actionItemCompletion! + w.goalVelocity!).toBeGreaterThan(w.cadenceAdherence!);
    });
  });

  describe("founder network: ad hoc, self-selected, narrative-weighted matching", () => {
    it("resolves to ad-hoc cadence (everyDays: 0, the same convention CADENCE_PRESETS.adhoc uses)", () => {
      const resolved = resolveCadence(FOUNDER_NETWORK_POLICY.cadence);
      expect(resolved.everyDays).toBe(0);
      expect(resolved.label).toBe("ad-hoc");
    });

    it("pairs by self-selection rather than centralised matching", () => {
      expect(FOUNDER_NETWORK_POLICY.pairing.mode).toBe("self_select");
    });

    it("leaves goals freeform and open-ended", () => {
      expect(FOUNDER_NETWORK_POLICY.goals).toMatchObject({
        structure: "freeform",
        cycleDays: 0,
      });
    });

    it("carries matching weights that lean on narrative/skill fit over availability", () => {
      // `matching` is an untyped passthrough on ProgramPolicySchema (core
      // cannot import MatchingPolicySchema — see the field comment in
      // policy.ts) so this asserts on the round-tripped shape, not a parsed
      // MatchingPolicy; packages/primitives/matching owns that parse.
      const weights = FOUNDER_NETWORK_POLICY.matching.weights as Record<string, number>;
      expect(weights.narrative_similarity ?? 0).toBeGreaterThan(weights.availability_overlap ?? 0);
      expect(weights.skill_fit_directional ?? 0).toBeGreaterThan(weights.availability_overlap ?? 0);
    });

    it("round-trips the matching block through ProgramPolicySchema.parse unchanged", () => {
      const parsed = ProgramPolicySchema.parse(FOUNDER_NETWORK_POLICY);
      expect(parsed.matching).toEqual(FOUNDER_NETWORK_POLICY.matching);
    });
  });

  it("cadence resolution still layers program -> cohort -> pair on top of any preset", () => {
    const resolved = resolveCadence(CORPORATE_CAREER_MENTORING_POLICY.cadence, undefined, {
      everyDays: 45,
    });
    expect(resolved.everyDays).toBe(45);
    // Untouched fields still come from the program-level preset.
    expect(resolved.sessionMinutes).toBe(CORPORATE_CAREER_MENTORING_POLICY.cadence.sessionMinutes);
  });
});
