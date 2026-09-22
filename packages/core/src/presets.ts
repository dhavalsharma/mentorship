import { defaultPolicy } from "./policy.js";
import type { ProgramPolicy } from "./policy.js";

/**
 * Three preset programs, as pure policy data (ADR-0001, action item 4 —
 * "the real test of the claim"). Each is `defaultPolicy(overrides)`: a plain
 * object literal, no branch, no tenant name anywhere in code. Forking one of
 * these for a real tenant means editing the object, not this file.
 *
 * Two of the three differences these presets need to express — a shape for
 * what a goal is, and a place for matching weights — did not exist on
 * `ProgramPolicySchema` before this file. Both gaps are now closed as data
 * fields (`goals`, `matching`) rather than as code branches; see the comments
 * on those fields in `policy.ts` for why each was a genuine schema gap and
 * not an escape hatch. No preset here required an `if` on a tenant name, a
 * saga variant, or anything StoredProgramPolicySchema/ProgramPolicySchema
 * cannot parse.
 */

/**
 * University mentoring: one mentor per mentee, fortnightly, bounded to a
 * semester. Recording is off (students, no data-retention appetite) and
 * AI processing stays optional rather than required.
 */
export const UNIVERSITY_MENTORING_POLICY: ProgramPolicy = defaultPolicy({
  roles: ["mentor", "mentee"],
  pairing: {
    mode: "matched",
    mentorCapacityDefault: 1,
    requireAdminApproval: true,
    importedPairsStart: "active",
  },
  cadence: {
    everyDays: 14,
    label: "fortnightly",
    sessionMinutes: 30,
    horizonDays: 14,
  },
  goals: {
    structure: "structured",
    cycleDays: 112, // ~16-week semester
    label: "semester",
    requireDueDate: true,
  },
  agreement: {
    resolution: "require_both",
    maxRounds: 2,
  },
  consent: {
    aiProcessing: "optional",
    recording: "off",
  },
  document: {
    namingTemplate: "{{pairTitle}} — mentoring log",
  },
  healthWeights: {
    cadenceAdherence: 0.35,
    actionItemCompletion: 0.15,
    goalVelocity: 0.25,
    reciprocity: 0.15,
    surveySentiment: 0.05,
    responseLatency: 0.05,
  },
});

/**
 * Corporate career mentoring: cadence stretches to monthly, mentors carry
 * more mentees (a group-leaning cardinality via `mentorCapacityDefault`, the
 * only cardinality lever the schema exposes — see the finding below), and
 * goals tie to a quarterly performance-review cycle. AI processing is
 * required (compliance already logs these conversations elsewhere); scores
 * lean on completion and velocity, the two things a review cycle asks about.
 */
export const CORPORATE_CAREER_MENTORING_POLICY: ProgramPolicy = defaultPolicy({
  roles: ["mentor", "mentee"],
  pairing: {
    mode: "matched",
    mentorCapacityDefault: 4,
    requireAdminApproval: true,
    importedPairsStart: "active",
  },
  cadence: {
    everyDays: 30,
    label: "monthly",
    sessionMinutes: 45,
    horizonDays: 21,
    proposeLeadDays: 7,
  },
  goals: {
    structure: "structured",
    cycleDays: 90,
    label: "quarter",
    requireDueDate: true,
  },
  agreement: {
    resolution: "require_both",
    maxRounds: 2,
    responseTimeoutHours: 72,
  },
  consent: {
    aiProcessing: "required",
    recording: "opt_in",
  },
  document: {
    namingTemplate: "{{pairTitle}} — career development plan",
  },
  healthWeights: {
    cadenceAdherence: 0.2,
    actionItemCompletion: 0.3,
    goalVelocity: 0.3,
    reciprocity: 0.1,
    surveySentiment: 0.05,
    responseLatency: 0.05,
  },
});

/**
 * Founder/startup network: ad hoc cadence (no fixed rhythm — `everyDays: 0`,
 * the same convention `CADENCE_PRESETS.adhoc` already uses), self-selected
 * pairing (founders browse and request rather than being matched centrally),
 * and goals stay freeform and open-ended. `matching.weights` leans on
 * narrative and skill fit over availability, since two founders will make
 * time for the right match — this is the field that required closing the
 * `ProgramPolicySchema.matching` gap (see `policy.ts`); it is opaque to core
 * and only means something once read by `readMatchingPolicy` in
 * `packages/primitives/matching`.
 */
export const FOUNDER_NETWORK_POLICY: ProgramPolicy = defaultPolicy({
  roles: ["mentor", "mentee"],
  pairing: {
    mode: "self_select",
    mentorCapacityDefault: 3,
    requireAdminApproval: false,
    importedPairsStart: "active",
  },
  cadence: {
    everyDays: 0,
    label: "ad-hoc",
    sessionMinutes: 30,
  },
  goals: {
    structure: "freeform",
    cycleDays: 0,
    label: "open-ended",
    requireDueDate: false,
  },
  agreement: {
    resolution: "proceed_on_one",
    maxRounds: 2,
  },
  consent: {
    aiProcessing: "optional",
    recording: "off",
  },
  document: {
    namingTemplate: "{{pairTitle}} — founder notes",
  },
  // Opaque to core (see field comment on `ProgramPolicySchema.matching`).
  // Keys mirror `MatchingPolicySchema.weights` in `packages/primitives/matching`.
  matching: {
    weights: {
      narrative_similarity: 0.4,
      skill_fit_directional: 0.35,
      availability_overlap: 0.1,
      level_gap_band: 0.05,
      stated_preference: 0.1,
    },
  },
  healthWeights: {
    cadenceAdherence: 0.05,
    actionItemCompletion: 0.15,
    goalVelocity: 0.15,
    reciprocity: 0.25,
    surveySentiment: 0.3,
    responseLatency: 0.1,
  },
});

export const PROGRAM_POLICY_PRESETS = {
  university: UNIVERSITY_MENTORING_POLICY,
  corporateCareer: CORPORATE_CAREER_MENTORING_POLICY,
  founderNetwork: FOUNDER_NETWORK_POLICY,
} as const satisfies Record<string, ProgramPolicy>;

export type ProgramPolicyPresetName = keyof typeof PROGRAM_POLICY_PRESETS;
