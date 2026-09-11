import { z } from "zod";

/**
 * Program policy is DATA, not code. This schema is the contract that makes the
 * platform generic: an organisation running fortnightly 1:1 career mentoring
 * and one running a monthly founder circle differ only in this document.
 */

export const CadenceSchema = z.object({
  /** 0 disables cadence-driven proposals entirely (ad-hoc programs). */
  everyDays: z.number().int().min(0).max(365),
  label: z.string().default("fortnightly"),
  sessionMinutes: z.number().int().min(15).max(240).default(45),
  /** How long before the meeting the reminder fires. */
  reminderLeadHours: z.number().min(0).max(168).default(24),
  /** How far ahead of the due date we start proposing times. */
  proposeLeadDays: z.number().int().min(0).max(30).default(5),
  /** Candidate slots are searched inside this horizon. */
  horizonDays: z.number().int().min(1).max(60).default(14),
  /** Working window used to generate candidate slots, in each party's local time. */
  workingHours: z
    .object({ startHour: z.number().min(0).max(23), endHour: z.number().min(1).max(24) })
    .default({ startHour: 9, endHour: 18 }),
});
export type Cadence = z.infer<typeof CadenceSchema>;

/**
 * Pairing is optional. A program may never run the matching primitive at all —
 * the common real-world case is an admin uploading a spreadsheet of pairs that
 * already exist. Every mode produces the same `pair.activated` event, so the
 * session lifecycle downstream is identical.
 */
export const PairingModeSchema = z.enum([
  "imported", // roster spreadsheet upload; matching never runs
  "manual", // admin pairs by hand in the UI
  "matched", // the matching primitive proposes, admin approves
  "self_select", // mentees browse and request
  "hybrid", // import what exists, match the remainder
]);
export type PairingMode = z.infer<typeof PairingModeSchema>;

export const AgreementPolicySchema = z.object({
  /** What to do when one party answers and the other never does. */
  resolution: z.enum(["require_both", "proceed_on_one"]).default("require_both"),
  /** Counter-proposal rounds before a human is pulled in. Uncapped negotiation is a nuisance. */
  maxRounds: z.number().int().min(1).max(5).default(2),
  responseTimeoutHours: z.number().min(1).max(336).default(48),
  renudgeAfterHours: z.number().min(1).max(336).default(48),
  escalateAfterHours: z.number().min(1).max(336).default(96),
});
export type AgreementPolicy = z.infer<typeof AgreementPolicySchema>;

export const ArtifactPolicySchema = z.object({
  /** Backoff schedule, in minutes after scheduled end, for transcript polling. */
  pollScheduleMinutes: z
    .array(z.number().int().positive())
    .default([15, 60, 240, 720, 1440]),
  /** After give-up, how long we keep the manual-notes request open. */
  manualNotesWindowHours: z.number().min(1).max(336).default(72),
});

export const ConsentPolicySchema = z.object({
  aiProcessing: z.enum(["required", "optional"]).default("optional"),
  /**
   * Recording consent is tracked separately from AI-processing consent: they
   * are different acts with different exposure, and in some jurisdictions
   * all-party consent to record is legally required. Off by default, always.
   */
  recording: z.enum(["off", "opt_in"]).default("off"),
});

/**
 * Which adapter fills each slot, per program. Null means the slot is empty and
 * the saga takes its documented degraded path — it does not fail.
 */
export const IntegrationProfileSchema = z.object({
  conversation: z.string().nullable().default(null),
  dm: z.string().nullable().default(null),
  calendar: z.string().nullable().default(null),
  conferencing: z.string().nullable().default(null),
  transcript: z.string().nullable().default(null),
  document: z.string().nullable().default(null),
  sheet: z.string().nullable().default(null),
  dashboard: z.string().nullable().default(null),
});
export type IntegrationProfile = z.infer<typeof IntegrationProfileSchema>;

export const ProgramPolicySchema = z.object({
  version: z.literal(1).default(1),
  roles: z.array(z.string()).default(["mentor", "mentee"]),
  pairing: z
    .object({
      mode: PairingModeSchema.default("matched"),
      mentorCapacityDefault: z.number().int().min(1).max(50).default(2),
      requireAdminApproval: z.boolean().default(true),
      /** Imported rows land straight in `active` unless the program wants an offer step. */
      importedPairsStart: z.enum(["active", "offered"]).default("active"),
    })
    .default({}),
  cadence: CadenceSchema.default({ everyDays: 14 }),
  agreement: AgreementPolicySchema.default({}),
  artifact: ArtifactPolicySchema.default({}),
  confirmation: z
    .object({
      /** On timeout the extraction is confirmed but flagged unverified — never silently promoted. */
      autoConfirmAfterHours: z.number().min(1).max(336).default(120),
    })
    .default({}),
  feedback: z
    .object({
      enabled: z.boolean().default(true),
      /** Always private. Nobody rates a meeting honestly in front of the other participant. */
      channel: z.literal("dm").default("dm"),
      windowHours: z.number().min(1).max(336).default(72),
    })
    .default({}),
  consent: ConsentPolicySchema.default({}),
  integrations: IntegrationProfileSchema.default({}),
  healthWeights: z
    .record(z.number())
    .default({
      cadenceAdherence: 0.3,
      actionItemCompletion: 0.2,
      goalVelocity: 0.2,
      reciprocity: 0.15,
      surveySentiment: 0.1,
      responseLatency: 0.05,
    }),
});

export type ProgramPolicy = z.infer<typeof ProgramPolicySchema>;

export function defaultPolicy(
  overrides: Partial<z.input<typeof ProgramPolicySchema>> = {},
): ProgramPolicy {
  return ProgramPolicySchema.parse(overrides);
}

/** Cadence resolves program default -> cohort -> the frequency the pair agreed to. */
export function resolveCadence(
  programCadence: Cadence,
  cohortOverride?: Partial<Cadence> | null,
  pairOverride?: Partial<Cadence> | null,
): Cadence {
  return CadenceSchema.parse({
    ...programCadence,
    ...(cohortOverride ?? {}),
    ...(pairOverride ?? {}),
  });
}

export const CADENCE_PRESETS: Record<string, Partial<Cadence>> = {
  weekly: { everyDays: 7, label: "weekly" },
  fortnightly: { everyDays: 14, label: "fortnightly" },
  monthly: { everyDays: 30, label: "monthly" },
  quarterly: { everyDays: 90, label: "quarterly" },
  adhoc: { everyDays: 0, label: "ad-hoc" },
};
